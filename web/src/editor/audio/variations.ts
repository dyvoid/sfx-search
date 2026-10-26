/**
 * Procedural Variation & Round-Robin Generator DSP Engine.
 *
 * Designed from first principles and psychoacoustics for creating natural
 * round-robin sets from a single recording:
 *
 * 1. Stratified Anti-Clumping Sampling:
 *    Guarantees the N takes spread evenly across the pitch/force space instead
 *    of clumping two takes on top of each other.
 * 2. Zero-Integral Internal Drift Normalization:
 *    Separates global Pitch Shift from internal time-varying Drift. The internal
 *    spline's integral is normalized to zero so internal movement never causes
 *    unintended duration bloat or loop-seam drift.
 * 3. Start / End Protection (Modulation Masking):
 *    Smoothly masks the internal drift spline at the start and/or end of the
 *    sound so transients stay phase-coherent and loop tails stay anchored.
 * 4. Physical Force-to-Brightness Coupling & Resonant Mode Jitter:
 *    Harder strikes are naturally louder AND brighter; striking slightly
 *    different spots jitters resonant mid peaks without changing the room decay.
 * 5. Attack Snap Variation:
 *    Varies the first ~30ms level & high-frequency crispness per take to defeat
 *    the "machine-gun" repetition effect even when pitch drift is 0%.
 */

import {
  applyDspChain,
  DEFAULT_EQ_SPEC,
  DEFAULT_SHAPER_SPEC,
  EqSpec,
} from "./dspChain";
import { fadeInGain, fadeOutGain } from "./loopdsp";

export type VariationMode = "foley" | "melodic";

export interface VariationSpec {
  mode: VariationMode;
  /** Number of variations to generate in a batch (1 to 12). */
  count: number;
  /** Global per-take pitch spread [0, 100]% (Foley: up to ±4 st; Melodic: micro-detune or quantized steps). */
  pitchShift: number;
  /** Internal time-varying pitch/speed drift [0, 100]% (zero-mean spline). */
  driftAmount: number;
  /** Internal volume contour & strike level spread [0, 100]%. */
  volumeAmount: number;
  /** Number of spline control points across the file (2 to 16). */
  controlPoints: number;
  /** Couple volume contour to pitch contour (louder = higher/brighter). */
  linkPitchAndVolume: boolean;
  /** Continuous timbre / resonant EQ spread [0, 100]% (0% = off, up to ±6 dB). */
  toneSpread: number;
  /** Protect start (fade-in the internal modulation spline over first X% of file) [0, 50]%. */
  protectStartPct: number;
  /** Protect end (fade-out the internal modulation spline over last X% of file) [0, 50]%. */
  protectEndPct: number;
  /** Explicit overall duration / speed spread per take [0, 25]%. */
  lengthSpreadPct: number;
  /** Compensate spectral tilt when pitch shifts so formants/body stay natural. */
  preserveFormants: boolean;
  /** Attack snap variation in the first 35ms [0, 100]% (defeats machine-gun effect). */
  attackSnap: number;
}

export const DEFAULT_VARIATION_SPEC: VariationSpec = {
  mode: "foley",
  count: 6,
  pitchShift: 35,
  driftAmount: 25,
  volumeAmount: 20,
  controlPoints: 5,
  linkPitchAndVolume: true,
  toneSpread: 35,
  protectStartPct: 15,
  protectEndPct: 10,
  lengthSpreadPct: 8,
  preserveFormants: true,
  attackSnap: 35,
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
  /** Global pitch shift in semitones for UI badge display. */
  meanSemitones: number;
  stretchRatio: number;
  eqTiltDb: [number, number, number];
  liked: boolean;
}

/** Deterministic Mulberry32 PRNG so any variation seed can be re-synthesized. */
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

/**
 * Evaluate the modulation protection mask at normalized position `t` in [0, 1].
 * Returns 0 at protected boundaries and ramps smoothly via a cosine curve to 1
 * in the interior.
 */
export function evalProtectionMask(
  t: number,
  protectStartPct: number,
  protectEndPct: number
): number {
  const sFrac = Math.max(0, Math.min(0.5, protectStartPct / 100));
  const eFrac = Math.max(0, Math.min(0.5, protectEndPct / 100));
  let m = 1;
  if (sFrac > 1e-4 && t < sFrac) {
    m *= fadeInGain("cosine", t / sFrac);
  }
  if (eFrac > 1e-4 && t > 1 - eFrac) {
    m *= fadeOutGain("cosine", (t - (1 - eFrac)) / eFrac);
  }
  return m;
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

// Quantized consonant scale intervals (in semitones) for large Melodic shifts
const MELODIC_SCALE_STEPS = [-12, -7, -5, -4, -3, -2, 0, 2, 3, 4, 5, 7, 12];

function quantizeMelodicSemitones(rawSt: number, pitchNorm: number): number {
  // At low-to-medium pitchShift (<= 45%), Melodic mode stays in the same key
  // using chorus-like micro-detuning (up to ±35 cents) so tonal stingers never clash.
  if (pitchNorm <= 0.45) {
    return rawSt * 0.18;
  }
  // Above 45%, snap to consonant scale intervals (2nds, 3rds, 4ths, 5ths)
  let best = 0;
  let bestDist = Infinity;
  for (const s of MELODIC_SCALE_STEPS) {
    const d = Math.abs(s - rawSt);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

/**
 * Generate a single organic variation from `sourceChannels`.
 * `stratifiedSlot` in [-1, 1] ensures a batch of N takes spans the parameter space evenly.
 */
export function synthesizeVariation(
  sourceChannels: readonly Float32Array[],
  sampleRate: number,
  spec: VariationSpec,
  index: number,
  baseName: string,
  seed?: number,
  stratifiedSlot?: number
): GeneratedVariation {
  const actualSeed =
    seed ?? ((Date.now() ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0);
  const rng = mulberry32(actualSeed);
  const randSigned = () => rng() * 2 - 1;

  const numPoints = Math.max(2, Math.min(16, Math.round(spec.controlPoints)));
  const pitchNorm = Math.max(0, Math.min(100, spec.pitchShift)) / 100;
  const driftNorm = Math.max(0, Math.min(100, spec.driftAmount)) / 100;
  const volNorm = Math.max(0, Math.min(100, spec.volumeAmount)) / 100;
  const toneNorm = Math.max(0, Math.min(100, spec.toneSpread)) / 100;
  const snapNorm = Math.max(0, Math.min(100, spec.attackSnap)) / 100;
  const lenSpreadNorm = Math.max(0, Math.min(25, spec.lengthSpreadPct)) / 100;

  // Stratified slot in [-1, 1] with small jitter so N takes never clump together
  const primaryBias =
    stratifiedSlot !== undefined
      ? Math.max(-1, Math.min(1, stratifiedSlot + randSigned() * 0.18))
      : randSigned();

  // 1. Global Pitch Shift (in semitones)
  const rawGlobalSt = primaryBias * 3.5 * pitchNorm;
  const globalSemitones =
    spec.mode === "melodic"
      ? quantizeMelodicSemitones(rawGlobalSt, pitchNorm)
      : rawGlobalSt;

  // 2. Strike Force Factor in [-1, 1] (used to physically correlate loudness, attack snap, and brightness)
  const strikeForce = Math.max(
    -1,
    Math.min(1, randSigned() * 0.7 + primaryBias * 0.3)
  );

  // 3. Build internal drift spline control points & enforce zero mean
  const driftPts: number[] = [];
  const volPts: number[] = [];
  for (let p = 0; p < numPoints; p++) {
    driftPts.push(randSigned());
    volPts.push(randSigned());
  }

  // Evaluate raw drift & volume splines on 256 grid steps, applying Start/End Protection mask
  const rateSteps = 256;
  const maskedDrift = new Float32Array(rateSteps);
  const maskedVol = new Float32Array(rateSteps);
  let driftSum = 0;

  for (let k = 0; k < rateSteps; k++) {
    const t = k / (rateSteps - 1);
    const mask = evalProtectionMask(
      t,
      spec.protectStartPct,
      spec.protectEndPct
    );
    const dVal = evalCatmullRom(driftPts, t) * mask;
    maskedDrift[k] = dVal;
    driftSum += dVal;

    const vRaw = spec.linkPitchAndVolume ? dVal : evalCatmullRom(volPts, t) * mask;
    maskedVol[k] = vRaw;
  }

  // Subtract mean drift across the interior so ∫ drift(t) dt = 0!
  // This prevents internal spline movement from unexpectedly stretching or shrinking the file.
  const driftMean = driftSum / rateSteps;
  for (let k = 0; k < rateSteps; k++) {
    const t = k / (rateSteps - 1);
    const mask = evalProtectionMask(
      t,
      spec.protectStartPct,
      spec.protectEndPct
    );
    maskedDrift[k] = (maskedDrift[k] - driftMean * mask) * driftNorm;
  }

  // Build 64-bin display curves for the take card canvas
  const curveBins = 64;
  const pitchCurve = new Float32Array(curveBins);
  const volumeCurve = new Float32Array(curveBins);
  const globalNormVis = Math.max(-0.85, Math.min(0.85, globalSemitones / 4.0));

  for (let b = 0; b < curveBins; b++) {
    const idx = Math.min(
      rateSteps - 1,
      Math.round((b / (curveBins - 1)) * (rateSteps - 1))
    );
    pitchCurve[b] = Math.max(
      -1,
      Math.min(1, globalNormVis * 0.55 + maskedDrift[idx] * 0.85)
    );
    volumeCurve[b] = Math.max(
      -1,
      Math.min(
        1,
        (strikeForce * 0.35 + maskedVol[idx] * 0.75) * volNorm
      )
    );
  }

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

  // 4. Compute exact playback rate table
  // Global pitch ratio + explicit length spread (decoupled from zero-mean internal drift)
  const globalPitchRatio = Math.pow(2, globalSemitones / 12);
  const lengthMultiplier = 1 + randSigned() * lenSpreadNorm;
  const targetMeanRate = Math.max(
    0.45,
    Math.min(2.2, globalPitchRatio / Math.max(0.5, lengthMultiplier))
  );

  // Max internal drift excursion in semitones (Foley: ±3.5 st, Melodic: ±0.6 st)
  const maxDriftSemitones = spec.mode === "foley" ? 3.5 : 0.6;
  const maxVolDb = 5.5 * volNorm;
  const globalGainDb = strikeForce * 2.2 * volNorm;

  const rateTable = new Float32Array(rateSteps);
  const gainTable = new Float32Array(rateSteps);
  let rawRateSum = 0;

  for (let k = 0; k < rateSteps; k++) {
    const instDriftSt = maskedDrift[k] * maxDriftSemitones;
    const r = targetMeanRate * Math.pow(2, instDriftSt / 12);
    rateTable[k] = r;
    rawRateSum += r;

    const db = globalGainDb + maskedVol[k] * maxVolDb;
    gainTable[k] = Math.pow(10, db / 20);
  }

  // Normalize rateTable so its average is strictly `targetMeanRate` (zero net length error from drift)
  const rateScale = (targetMeanRate * rateSteps) / Math.max(1e-6, rawRateSum);
  for (let k = 0; k < rateSteps; k++) {
    rateTable[k] = Math.max(0.35, Math.min(2.6, rateTable[k] * rateScale));
  }

  // 5. Attack Snap Variation (first 32ms transient punch & high-frequency crispness)
  // Physically correlated with `strikeForce` plus independent micro-variance
  const attackEmphasisDb =
    (strikeForce * 0.55 + randSigned() * 0.45) * 4.5 * snapNorm;
  const attackWindowSamples = Math.max(1, Math.round(sampleRate * 0.032));

  const estOutLen = Math.max(
    16,
    Math.min(
      srcLen * 3,
      Math.ceil(srcLen / Math.max(0.35, targetMeanRate)) + 128
    )
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

    if (i < attackWindowSamples && Math.abs(attackEmphasisDb) > 0.05) {
      const env = 1 - i / attackWindowSamples;
      instGain *= Math.pow(10, (attackEmphasisDb * env) / 20);
    }

    for (let c = 0; c < sourceChannels.length; c++) {
      tempChannels[c][i] = sampleHermite(sourceChannels[c], readPos) * instGain;
    }

    readPos += instRate;
    actualOutLen = i + 1;
  }

  let outChannels = tempChannels.map((ch) => ch.subarray(0, actualOutLen));

  // 6. Physically-Correlated Tone Spread ( Strike Brightness + Resonant Mode Jitter + Formant Preservation )
  let lowDb = 0;
  let midDb = 0;
  let highDb = 0;
  let midFreq = 1200;

  if (toneNorm > 0.01) {
    const maxEqDb = 6.0 * toneNorm;
    // Harder strikes (strikeForce > 0) naturally excite more high frequencies;
    // softer strikes roll off highs slightly.
    const forceTilt = strikeForce * 0.55 + randSigned() * 0.45;
    highDb += forceTilt * maxEqDb;
    lowDb += (-forceTilt * 0.4 + randSigned() * 0.6) * (maxEqDb * 0.8);
    // Resonant mid peak models striking a slightly different node/position on the object
    midDb += randSigned() * maxEqDb * 0.9;
    midFreq = Math.round(550 + rng() * 2600);
  }

  if (spec.preserveFormants && Math.abs(globalSemitones) > 0.15) {
    const comp = Math.max(-5.5, Math.min(5.5, globalSemitones * 0.65));
    lowDb += comp * 0.75;
    midDb -= comp * 0.35;
    highDb -= comp * 0.85;
  }

  const eqNeeded =
    Math.abs(lowDb) > 0.1 || Math.abs(midDb) > 0.1 || Math.abs(highDb) > 0.1;
  const eqSpec: EqSpec = {
    ...DEFAULT_EQ_SPEC,
    lowGainDb: lowDb,
    midGainDb: midDb,
    midFreqHz: midFreq,
    midQ: 1.1 + rng() * 1.2,
    highGainDb: highDb,
  };

  if (eqNeeded) {
    outChannels = applyDspChain(
      outChannels,
      sampleRate,
      DEFAULT_SHAPER_SPEC,
      eqSpec
    );
  }

  // Peak ceiling guard at -0.2 dBFS
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
    meanSemitones: globalSemitones,
    stretchRatio: actualOutLen / Math.max(1, srcLen),
    eqTiltDb: [
      Math.round(lowDb * 10) / 10,
      Math.round(midDb * 10) / 10,
      Math.round(highDb * 10) / 10,
    ],
    liked: false,
  };
}

/**
 * Generate a batch of N variations using stratified Latin-hypercube style slots
 * so the set is guaranteed to span the parameter range without clumping.
 */
export function generateVariationBatch(
  sourceChannels: readonly Float32Array[],
  sampleRate: number,
  spec: VariationSpec,
  baseName: string
): GeneratedVariation[] {
  const count = Math.max(1, Math.min(12, Math.round(spec.count)));
  const out: GeneratedVariation[] = [];
  const baseSeed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  const rng = mulberry32(baseSeed);

  // Create stratified slots in [-1, 1] and shuffle their order
  const slots: number[] = [];
  for (let i = 0; i < count; i++) {
    const slot = count === 1 ? 0 : -1 + (2 * (i + 0.5)) / count;
    slots.push(slot);
  }
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = slots[i];
    slots[i] = slots[j];
    slots[j] = tmp;
  }

  for (let i = 0; i < count; i++) {
    const seed = (baseSeed + Math.imul(i + 1, 0x85ebca6b)) >>> 0;
    out.push(
      synthesizeVariation(
        sourceChannels,
        sampleRate,
        spec,
        i,
        baseName,
        seed,
        slots[i]
      )
    );
  }
  return out;
}
