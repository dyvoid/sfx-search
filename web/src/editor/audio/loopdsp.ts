/**
 * Core loop DSP: crossfade curves, loop baking, seam continuity analysis,
 * and zero-crossing snapping.
 *
 * A "loop" is defined by a start sample S, an end sample E (exclusive), and a
 * fade length F. The baked output is a buffer of length E-S that loops
 * seamlessly. Three crossfade placements exist:
 *
 *  - 'pre':  the last F output samples blend the loop tail src[E-F..E] with the
 *            F samples *before* the loop start, src[S-F..S]. The seam then wraps
 *            into src[S] as natural continuation — always smooth. Needs S >= F.
 *  - 'post': the first F output samples blend src[S..S+F] with src[E..E+F], the
 *            audio *after* the loop end. Wraps src[E-1] -> src[E] naturally.
 *            Needs E+F <= length.
 *  - 'head': the last F output samples blend src[E-F..E] with src[S..S+F], the
 *            loop's own head. Always possible, but only seamless when the
 *            content is self-similar across the seam (e.g. auto-search hits).
 *
 * 'auto' picks 'pre', then 'post', then 'head' by feasibility.
 */

export type FadeCurve = "linear" | "equal-power" | "cosine";
export type BakeMode = "auto" | "pre" | "post" | "head";
export type ResolvedMode = "pre" | "post" | "head";

export interface LoopSpec {
  /** Loop start, sample index (inclusive). */
  start: number;
  /** Loop end, sample index (exclusive). */
  end: number;
  /** Crossfade length in samples. */
  fadeLength: number;
  curve: FadeCurve;
  mode: BakeMode;
}

export interface BakedLoop {
  buffers: Float32Array[];
  mode: ResolvedMode;
  /** True when the crossfade sits at the head of the buffer (mode 'post'). */
  fadeAtHead: boolean;
}

export function fadeInGain(curve: FadeCurve, t: number): number {
  switch (curve) {
    case "linear":
      return t;
    case "equal-power":
      return Math.sin((t * Math.PI) / 2);
    case "cosine":
      return (1 - Math.cos(t * Math.PI)) / 2;
  }
}

export function fadeOutGain(curve: FadeCurve, t: number): number {
  switch (curve) {
    case "linear":
      return 1 - t;
    case "equal-power":
      return Math.cos((t * Math.PI) / 2);
    case "cosine":
      return (1 + Math.cos(t * Math.PI)) / 2;
  }
}

function feasible(
  mode: ResolvedMode,
  start: number,
  end: number,
  fade: number,
  len: number
): boolean {
  switch (mode) {
    case "pre":
      return start - fade >= 0;
    case "post":
      return end + fade <= len;
    case "head":
      return true;
  }
}

/** Resolve the requested mode to a concrete placement, falling back through the auto chain. */
export function resolveMode(
  mode: BakeMode,
  start: number,
  end: number,
  fadeLength: number,
  sourceLength: number
): ResolvedMode {
  const order: ResolvedMode[] =
    mode === "auto" ? ["pre", "post", "head"] : [mode, "pre", "post", "head"];
  for (const m of order) {
    if (feasible(m, start, end, fadeLength, sourceLength)) {
      return m;
    }
  }
  return "head";
}

/**
 * Bake the loop into a new set of channel buffers that loop seamlessly.
 * Throws on an invalid loop region; clamps fadeLength to the loop length.
 */
export function bakeLoop(
  channels: readonly Float32Array[],
  spec: LoopSpec
): BakedLoop {
  if (channels.length === 0) {
    throw new RangeError("no channels");
  }
  const len = channels[0].length;
  const start = Math.floor(spec.start);
  const end = Math.floor(spec.end);
  if (start < 0 || end > len || end - start < 2) {
    throw new RangeError(
      `invalid loop region [${start}, ${end}) in ${len} samples`
    );
  }
  const loopLen = end - start;
  const F = Math.max(0, Math.min(Math.floor(spec.fadeLength), loopLen));
  const mode = resolveMode(spec.mode, start, end, F, len);

  const buffers = channels.map((src) => {
    const out = new Float32Array(loopLen);
    out.set(src.subarray(start, end));
    if (F > 0) {
      for (let q = 0; q < F; q++) {
        // mid-sample t keeps the gains strictly inside (0,1) at the edges
        const t = (q + 0.5) / F;
        const g = fadeOutGain(spec.curve, t);
        const f = fadeInGain(spec.curve, t);
        if (mode === "pre") {
          const i = loopLen - F + q;
          out[i] = src[end - F + q] * g + src[start - F + q] * f;
        } else if (mode === "post") {
          out[q] = src[end + q] * g + src[start + q] * f;
        } else {
          const i = loopLen - F + q;
          out[i] = src[end - F + q] * g + src[start + q] * f;
        }
      }
    }
    return out;
  });

  return { buffers, mode, fadeAtHead: mode === "post" };
}

export type ZeroCrossEdge = "rising" | "falling" | "any";

/**
 * Find the nearest zero crossing to `position` within `maxDeviation` samples.
 * Returns the crossing index (the first sample of the new sign), or the
 * original position clamped into range when no crossing is found.
 */
export function snapToZeroCrossing(
  channel: Float32Array,
  position: number,
  maxDeviation = 4096,
  edge: ZeroCrossEdge = "rising"
): number {
  const len = channel.length;
  const pos = Math.max(1, Math.min(Math.round(position), len - 1));
  const lo = Math.max(1, pos - maxDeviation);
  const hi = Math.min(len - 1, pos + maxDeviation);
  let best = -1;
  let bestDist = Infinity;
  for (let p = lo + 1; p <= hi; p++) {
    const a = channel[p - 1];
    const b = channel[p];
    const rising = a <= 0 && b > 0;
    const falling = a >= 0 && b < 0;
    const hit =
      edge === "any"
        ? rising || falling
        : edge === "rising"
        ? rising
        : falling;
    if (hit) {
      const d = Math.abs(p - pos);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
  }
  return best >= 0 ? best : pos;
}

export interface SeamMetrics {
  /** Absolute sample jump at the wrap boundary (0 = sample-continuous). */
  stepDelta: number;
  /** First-derivative (slope) continuity score in [0, 1]. */
  slopeContinuity: number;
  /** RMS ratio consistency across the wrap window in [0, 1]. */
  energyMatch: number;
  /** Composite seam quality in [0, 1]. */
  seamScore: number;
}

/**
 * Evaluate how smooth the baked loop's wrap-around boundary is (`out[len-1] -> out[0]`).
 */
export function evaluateBakedSeam(
  bakedChannels: readonly Float32Array[],
  sampleRate: number
): SeamMetrics {
  const ch = bakedChannels[0];
  if (!ch || ch.length < 8) {
    return { stepDelta: 0, slopeContinuity: 1, energyMatch: 1, seamScore: 1 };
  }
  const n = ch.length;
  const stepDelta = Math.abs(ch[0] - ch[n - 1]);

  const slopeTail = ch[n - 1] - ch[n - 2];
  const slopeWrap = ch[0] - ch[n - 1];
  const slopeHead = ch[1] - ch[0];
  const avgSlopeJump =
    (Math.abs(slopeWrap - slopeTail) + Math.abs(slopeHead - slopeWrap)) / 2;
  const slopeContinuity = Math.max(0, Math.min(1, 1 - avgSlopeJump * 6));

  const win = Math.min(Math.floor(n / 4), Math.max(32, Math.round(sampleRate * 0.05)));
  let rmsTail = 0;
  let rmsHead = 0;
  for (let i = 0; i < win; i++) {
    const a = ch[n - win + i];
    const b = ch[i];
    rmsTail += a * a;
    rmsHead += b * b;
  }
  rmsTail = Math.sqrt(rmsTail / Math.max(1, win));
  rmsHead = Math.sqrt(rmsHead / Math.max(1, win));
  const maxRms = Math.max(rmsTail, rmsHead, 1e-6);
  const minRms = Math.min(rmsTail, rmsHead);
  const energyMatch = maxRms < 1e-4 ? 1 : minRms / maxRms;

  const stepScore = Math.max(0, Math.min(1, 1 - stepDelta * 4));
  const seamScore = Math.max(
    0,
    Math.min(1, stepScore * 0.45 + slopeContinuity * 0.25 + energyMatch * 0.3)
  );
  return {
    stepDelta,
    slopeContinuity,
    energyMatch,
    seamScore,
  };
}
