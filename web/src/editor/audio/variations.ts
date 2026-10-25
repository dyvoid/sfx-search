/**
 * Procedural Variation & Round-Robin Generator DSP Engine.
 *
 * Inspired by Ocular Sounds Telescope / game-audio variation workflows:
 * generates organic round-robin takes from a single source/edited sound by
 * synthesizing smooth multi-point Catmull-Rom modulation splines for pitch
 * and volume, randomized 3-band EQ coloration, formant preservation,
 * time-stretch jitter, motion fades, and transient humanization.
 */

import { applyDspChain, DEFAULT_EQ_SPEC, DEFAULT_SHAPER_SPEC, EqSpec } from "./dspChain";
import { fadeInGain, fadeOutGain } from "./loopdsp";

export type VariationMode = "foley" | "melodic";

export interface VariationSpec {
  mode: VariationMode;
  /** Number of variations to generate in a batch (1 to 12). */
  count: number;
  /** Pitch modulation depth in [0, 100]%. */
  pitchAmount: number;
  /** Volume modulation depth in [0, 100]%. */
  volumeAmount: number;
  /** Number of envelope control points (2 to 16). */
  controlPoints: number;
  /** Couple volume envelope to pitch envelope contour. */
  linkPitchAndVolume: boolean;
  /** Randomize low / mid / high EQ per variation. */
  randomizeEq: boolean;
  /** Motion fade-in percentage of total length [0, 50]%. */
  fadeInPct: number;
  /** Motion fade-out percentage of total length [0, 50]%. */
  fadeOutPct: number;
  /** Apply variable time-stretch (random length & pitch drift). */
  timeStretch: boolean;
  /** Compensate spectral envelope when pitch shifts so formants stay natural. */
  preserveFormants: boolean;
  /** Humanize micro-timing, transient emphasis, and stereo/phase micro-variance [0, 100]%. */
  humanize: number;
}

export const DEFAULT_VARIATION_SPEC: VariationSpec = {
  mode: "foley",
  count: 6,
  pitchAmount: 35,
  volumeAmount: 15,
  controlPoints: 5,
  linkPitchAndVolume: false,
  randomizeEq: true,
  fadeInPct: 0,
  fadeOutPct: 0,
  timeStretch: true,
  preserveFormants: true,
  humanize: 30,
};

export interface GeneratedVariation {
  id: string;
  index: number;
  name: string;
  seed: number;
  channels: Float32Array[];
  sampleRate: number;
  durationS: number;
  /** Downsampled peak envelope (64 bins) for fast card rendering. */
  peaks: Float32Array;
  /** Normalized pitch modulation curve (64 bins in [-1, 1]) for visual inspection. */
  pitchCurve: Float32Array;
  /** Normalized volume modulation curve (64 bins in [-1, 1]). */
  volumeCurve: Float32Array;
  /** Summary metrics for UI badge display. */
  meanSemitones: number;
  stretchRatio: number;
  eqTiltDb: [number, number, number];
  liked: boolean;
}

/** Deterministic Mulberry32 PRNG so any variation seed can be re-synthesized or tweaked. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Evaluate a Catmull-Rom spline through `pts` at normalized `t` in [0, 1]. */
function evalCatmullRom(pts: readonly number[], t: number): number {
  const n = pts.length;
  if (n === 0) {
    return 0;
  }
  if (n === 1) {
    return pts[0];
  }
  const scaled = Math.max(0, Math.min(1, t)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(scaled));
  const u = scaled - i;

  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[Math.min(n - 1, i + 1)];
  const p3 = pts[Math.min(n - 1, i + 2)];

  const u2 = u * u;
  const u3 = u2 * u;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * u +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
  );
}

/** 4-point cubic Hermite interpolation on an audio channel for low-aliasing resampling. */
function sampleHermite(ch: Float32Array, pos: number): number {
  const len = ch.length;
  const i = Math.floor(pos);
  const f = pos - i;
  const xm1 = ch[Math.max(0, Math.min(len - 1, i - 1))];
  const x0 = ch[Math.max(0, Math.min(len - 1, i))];
  const x1 = ch[Math.max(0, Math.min(len - 1, i + 1))];
  const x2 = ch[Math.max(0, Math.min(len - 1, i + 2))];

  const c = (x1 - xm1) * 0.5;
  const v = x0 - x1;
  const w = c + v;
  const a = w + v + (x2 - x0) * 0.5;
  const bNeg = w + a;
  return ((a * f - bNeg) * f + c) * f + x0;
}

function computeMiniPeaks(ch: Float32Array, bins = 64): Float32Array {
  const out = new Float32Array(bins);
  const len = ch.length;
  if (len === 0) {
    return out;
  }
  let globalMax = 0.001;
  for (let i = 0; i < len; i++) {
    const a = Math.abs(ch[i]);
    if (a > globalMax) {
      globalMax = a;
    }
  }
  for (let b = 0; b < bins; b++) {
    const s0 = Math.floor((b * len) / bins);
    const s1 = Math.max(s0 + 1, Math.floor(((b + 1) * len) / bins));
    let pk = 0;
    for (let i = s0; i < s1 && i < len; i++) {
      const a = Math.abs(ch[i]);
      if (a > pk) {
        pk = a;
      }
    }
    out[b] = Math.min(1, pk / globalMax);
  }
  return out;
}

/**
 * Generate a single organic variation from `sourceChannels`.
 */
export function synthesizeVariation(
  sourceChannels: readonly Float32Array[],
  sampleRate: number,
  spec: VariationSpec,
  index: number,
  baseName: string,
  seed?: number
): GeneratedVariation {
  const actualSeed =
    seed ?? ((Date.now() ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0);
  const rng = mulberry32(actualSeed);
  const randSigned = () => rng() * 2 - 1;

  const numPoints = Math.max(2, Math.min(16, Math.round(spec.controlPoints)));
  const pitchNorm = Math.max(0, Math.min(100, spec.pitchAmount)) / 100;
  const volNorm = Math.max(0, Math.min(100, spec.volumeAmount)) / 100;
  const humanNorm = Math.max(0, Math.min(100, spec.humanize)) / 100;

  // Build control points in [-1, 1]
  const pitchPts: number[] = [];
  const volPts: number[] = [];

  // Overall base pitch offset + time-stretch drift
  const basePitchOffset = randSigned() * 0.65;
  for (let p = 0; p < numPoints; p++) {
    if (spec.mode === "melodic") {
      // Melodic mode: gentler drift around a quantized semitone center
      const v = Math.max(-1, Math.min(1, basePitchOffset + randSigned() * 0.28));
      pitchPts.push(v);
    } else {
      // Foley mode: dynamic organic contour across the event
      const v = Math.max(-1, Math.min(1, basePitchOffset * 0.45 + randSigned() * 0.85));
      pitchPts.push(v);
    }

    if (spec.linkPitchAndVolume) {
      volPts.push(pitchPts[p]);
    } else {
      volPts.push(randSigned());
    }
  }

  // Max semitone excursion:
  // Foley mode up to +/- 7 semitones at 100%, Melodic mode up to +/- 4 semitones
  const maxSemitones = (spec.mode === "foley" ? 7.0 : 4.0) * pitchNorm;
  // Max volume modulation in dB: up to +/- 6.5 dB at 100%
  const maxVolDb = 6.5 * volNorm;

  // Time-stretch global rate factor
  const stretchJitter = spec.timeStretch
    ? 1 + randSigned() * (0.14 * Math.max(0.25, pitchNorm) + 0.08 * humanNorm)
    : 1.0;

  // Evaluate 64-bin preview curves and integrate phase walk to determine output length
  const curveBins = 64;
  const pitchCurve = new Float32Array(curveBins);
  const volumeCurve = new Float32Array(curveBins);
  let semitoneSum = 0;

  for (let b = 0; b < curveBins; b++) {
    const t = b / Math.max(1, curveBins - 1);
    const pVal = evalCatmullRom(pitchPts, t);
    const vVal = spec.linkPitchAndVolume ? pVal : evalCatmullRom(volPts, t);
    pitchCurve[b] = Math.max(-1, Math.min(1, pVal * pitchNorm));
    volumeCurve[b] = Math.max(-1, Math.min(1, vVal * volNorm));
    semitoneSum += pVal * maxSemitones;
  }
  const meanSemitones = semitoneSum / curveBins;

  const srcLen = sourceChannels[0]?.length ?? 0;
  if (srcLen < 4) {
    return {
      id: `${actualSeed}-${index}`,
      index,
      name: `${baseName}_var_${String(index + 1).padStart(2, "0")}`,
      seed: actualSeed,
      channels: sourceChannels.map((c) => new Float32Array(c)),
      sampleRate,
      durationS: srcLen / Math.max(1, sampleRate),
      peaks: new Float32Array(64),
      pitchCurve,
      volumeCurve,
      meanSemitones: 0,
      stretchRatio: 1,
      eqTiltDb: [0, 0, 0],
      liked: false,
    };
  }

  // Pre-compute instantaneous playback rate at 256 table steps so inner loop is fast
  const rateSteps = 256;
  const rateTable = new Float32Array(rateSteps);
  const gainTable = new Float32Array(rateSteps);
  let avgRate = 0;

  for (let k = 0; k < rateSteps; k++) {
    const t = k / (rateSteps - 1);
    let semi = evalCatmullRom(pitchPts, t) * maxSemitones;
    if (spec.mode === "melodic" && Math.abs(semi) > 0.05) {
      // Softly pull toward nearest semitone in melodic mode
      const nearest = Math.round(semi);
      semi = nearest * 0.72 + semi * 0.28;
    }
    const pitchRatio = Math.pow(2, semi / 12);
    const r = Math.max(0.4, Math.min(2.4, pitchRatio * stretchJitter));
    rateTable[k] = r;
    avgRate += r;

    const vRaw = spec.linkPitchAndVolume
      ? evalCatmullRom(pitchPts, t)
      : evalCatmullRom(volPts, t);
    const db = vRaw * maxVolDb + randSigned() * humanNorm * 0.6;
    gainTable[k] = Math.pow(10, db / 20);
  }
  avgRate /= rateSteps;

  // Humanize: subtle attack transient punch / softness envelope
  const transientPunchDb = randSigned() * 3.5 * humanNorm;
  const transientDecaySamples = Math.max(1, Math.round(sampleRate * 0.035));

  // Resample all channels along the integrated read-head trajectory
  const estOutLen = Math.max(
    16,
    Math.min(srcLen * 3, Math.ceil(srcLen / Math.max(0.35, avgRate)) + 64)
  );
  const tempChannels = sourceChannels.map(() => new Float32Array(estOutLen));

  let readPos = 0;
  let actualOutLen = 0;
  const invSrcLen = 1 / Math.max(1, srcLen - 1);

  for (let i = 0; i < estOutLen; i++) {
    if (readPos >= srcLen - 1) {
      break;
    }
    const progress = Math.min(1, readPos * invSrcLen);
    const tblPos = progress * (rateSteps - 1);
    const k0 = Math.floor(tblPos);
    const k1 = Math.min(rateSteps - 1, k0 + 1);
    const frac = tblPos - k0;

    const instRate = rateTable[k0] * (1 - frac) + rateTable[k1] * frac;
    let instGain = gainTable[k0] * (1 - frac) + gainTable[k1] * frac;

    if (i < transientDecaySamples && Math.abs(transientPunchDb) > 0.05) {
      const env = 1 - i / transientDecaySamples;
      instGain *= Math.pow(10, (transientPunchDb * env) / 20);
    }

    for (let c = 0; c < sourceChannels.length; c++) {
      tempChannels[c][i] = sampleHermite(sourceChannels[c], readPos) * instGain;
    }

    readPos += instRate;
    actualOutLen = i + 1;
  }

  let outChannels = tempChannels.map((ch) => ch.subarray(0, actualOutLen));

  // Motion Fade-In & Fade-Out
  const fadeInSamples = Math.floor(
    (Math.max(0, Math.min(50, spec.fadeInPct)) / 100) * actualOutLen
  );
  const fadeOutSamples = Math.floor(
    (Math.max(0, Math.min(50, spec.fadeOutPct)) / 100) * actualOutLen
  );
  if (fadeInSamples > 1) {
    for (const ch of outChannels) {
      for (let i = 0; i < fadeInSamples; i++) {
        ch[i] *= fadeInGain("cosine", (i + 0.5) / fadeInSamples);
      }
    }
  }
  if (fadeOutSamples > 1) {
    const startIdx = actualOutLen - fadeOutSamples;
    for (const ch of outChannels) {
      for (let i = 0; i < fadeOutSamples; i++) {
        ch[startIdx + i] *= fadeOutGain("cosine", (i + 0.5) / fadeOutSamples);
      }
    }
  }

  // Tone: Randomize EQ + Formant Preservation compensation
  // When a sound is pitched up, its spectral centroid shifts up artificially ("chipmunk" effect).
  // Formant preservation applies an inverse spectral tilt (boosting low-mids and attenuating highs
  // on upward shifts, and vice versa on downward shifts) so the body/formant stays anchored.
  let lowDb = 0;
  let midDb = 0;
  let highDb = 0;
  let midFreq = 1200;

  if (spec.randomizeEq) {
    const eqSpread = 3.5 + humanNorm * 2.5;
    lowDb += randSigned() * eqSpread;
    midDb += randSigned() * (eqSpread * 0.85);
    highDb += randSigned() * eqSpread;
    midFreq = Math.round(650 + rng() * 2400);
  }

  if (spec.preserveFormants && Math.abs(meanSemitones) > 0.15) {
    const comp = Math.max(-6, Math.min(6, meanSemitones * 0.65));
    lowDb += comp * 0.75;
    midDb -= comp * 0.35;
    highDb -= comp * 0.85;
  }

  const eqSpec: EqSpec = {
    ...DEFAULT_EQ_SPEC,
    enabled:
      Math.abs(lowDb) > 0.1 || Math.abs(midDb) > 0.1 || Math.abs(highDb) > 0.1,
    lowGainDb: lowDb,
    midGainDb: midDb,
    midFreqHz: midFreq,
    midQ: 0.9 + rng() * 0.8,
    highGainDb: highDb,
  };

  if (eqSpec.enabled) {
    outChannels = applyDspChain(
      outChannels,
      sampleRate,
      DEFAULT_SHAPER_SPEC,
      eqSpec
    );
  }

  // Soft-clip / peak-guard so heavy EQ + volume boosts never digital-clip above -0.2 dBFS
  let maxPeak = 0;
  for (const ch of outChannels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > maxPeak) {
        maxPeak = a;
      }
    }
  }
  const ceiling = Math.pow(10, -0.2 / 20);
  if (maxPeak > ceiling) {
    const norm = ceiling / maxPeak;
    for (const ch of outChannels) {
      for (let i = 0; i < ch.length; i++) {
        ch[i] *= norm;
      }
    }
  }

  return {
    id: `${actualSeed}-${index}`,
    index,
    name: `${baseName}_var_${String(index + 1).padStart(2, "0")}`,
    seed: actualSeed,
    channels: outChannels,
    sampleRate,
    durationS: actualOutLen / Math.max(1, sampleRate),
    peaks: computeMiniPeaks(outChannels[0], 64),
    pitchCurve,
    volumeCurve,
    meanSemitones,
    stretchRatio: actualOutLen / Math.max(1, srcLen),
    eqTiltDb: [
      Math.round(lowDb * 10) / 10,
      Math.round(midDb * 10) / 10,
      Math.round(highDb * 10) / 10,
    ],
    liked: false,
  };
}

export function generateVariationBatch(
  sourceChannels: readonly Float32Array[],
  sampleRate: number,
  spec: VariationSpec,
  baseName: string
): GeneratedVariation[] {
  const count = Math.max(1, Math.min(12, Math.round(spec.count)));
  const out: GeneratedVariation[] = [];
  const baseSeed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  for (let i = 0; i < count; i++) {
    const seed = (baseSeed + Math.imul(i + 1, 0x85ebca6b)) >>> 0;
    out.push(
      synthesizeVariation(sourceChannels, sampleRate, spec, i, baseName, seed)
    );
  }
  return out;
}
