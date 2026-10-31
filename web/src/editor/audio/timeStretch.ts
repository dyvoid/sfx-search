/**
 * Pitch-preserving time-stretch (WSOLA: waveform-similarity overlap-add).
 *
 * Hann-windowed frames are copied from the input at half-frame output hops.
 * Each frame's read position may move a little (±10 ms) to where the input
 * best continues the previous frame, so the overlaps stay in phase and the
 * pitch is unchanged. Offsets are found on a mono mix and shared by all
 * channels, so stereo images stay intact.
 */

const FRAME_S = 0.04;
const TOLERANCE_S = 0.01;
/** Correlate on every Nth sample, and scan offsets in steps of N before refining. */
const DECIMATE = 8;

/** `factor` > 1 makes the sound longer, < 1 shorter; the pitch stays the same. */
export function timeStretch(
  channels: readonly Float32Array[],
  sampleRate: number,
  factor: number
): Float32Array[] {
  const inLen = channels[0]?.length ?? 0;
  const frame = Math.max(64, 2 * Math.round((FRAME_S * sampleRate) / 2));
  if (inLen < frame * 2 || Math.abs(factor - 1) < 0.002) {
    return channels.map((c) => new Float32Array(c));
  }
  const hopOut = frame / 2;
  const hopIn = hopOut / factor;
  const tol = Math.round(TOLERANCE_S * sampleRate);
  const outLen = Math.max(1, Math.round(inLen * factor));

  const win = new Float32Array(frame);
  for (let i = 0; i < frame; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);
  }
  const mono = new Float32Array(inLen);
  for (const ch of channels) {
    for (let i = 0; i < inLen; i++) {
      mono[i] += ch[i] / channels.length;
    }
  }
  const at = (sig: Float32Array, i: number): number => (i >= 0 && i < inLen ? sig[i] : 0);
  // Similarity of the overlap region: input at `cand` vs the natural continuation at `ref`.
  const similarity = (cand: number, ref: number): number => {
    let sum = 0;
    for (let i = 0; i < hopOut; i += DECIMATE) {
      sum += at(mono, cand + i) * at(mono, ref + i);
    }
    return sum;
  };

  const out = channels.map(() => new Float32Array(outLen + frame));
  const norm = new Float32Array(outLen + frame);
  let prevIn = 0;
  for (let k = 0; k * hopOut < outLen; k++) {
    const outPos = k * hopOut;
    const ideal = Math.round(k * hopIn);
    let inPos = ideal;
    if (k > 0) {
      const ref = prevIn + hopOut;
      let best = ideal;
      let bestScore = -Infinity;
      for (let d = -tol; d <= tol; d += DECIMATE) {
        const s = similarity(ideal + d, ref);
        if (s > bestScore) {
          bestScore = s;
          best = ideal + d;
        }
      }
      // Refine around the coarse best, one sample at a time.
      const coarse = best;
      for (let d = coarse - DECIMATE + 1; d < coarse + DECIMATE; d++) {
        if (d < ideal - tol || d > ideal + tol || d === coarse) {
          continue;
        }
        const s = similarity(d, ref);
        if (s > bestScore) {
          bestScore = s;
          best = d;
        }
      }
      inPos = best;
    }
    prevIn = inPos;
    for (let i = 0; i < frame; i++) {
      const w = win[i];
      norm[outPos + i] += w;
      for (let c = 0; c < channels.length; c++) {
        out[c][outPos + i] += at(channels[c], inPos + i) * w;
      }
    }
  }

  // Divide by the summed windows: where one frame covers alone (the very
  // start) this restores the input exactly, so attacks are not faded in.
  return out.map((ch) => {
    const res = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      res[i] = norm[i] > 1e-6 ? ch[i] / norm[i] : 0;
    }
    return res;
  });
}
