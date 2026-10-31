/**
 * Modular non-destructive DSP effects chain for the SFX Studio Editor.
 *
 * Pipeline order:
 *   Source PCM -> [Shaper: Gain / Normalize / Reverse / Fade-In / Fade-Out]
 *              -> [Tone EQ: HPF / Low-Shelf / Mid-Peak / High-Shelf / LPF]
 *              -> [Loop Module: Seamless Crossfade Bake]
 */

import { FadeCurve, fadeInGain, fadeOutGain } from "./loopdsp";

export interface ShaperSpec {
  /** Crop / trim start offset from the beginning of the source file (ms). */
  trimStartMs: number;
  /** Crop / trim amount removed from the end of the source file (ms). */
  trimEndMs: number;
  /** Output gain in dB (-24 to +24). */
  gainDb: number;
  /** Target peak normalization in dBFS (null = off, e.g. -1.0 dBFS). */
  normalizePeakDbfs: number | null;
  /** Fade-in at start of cropped region in milliseconds. */
  fadeInMs: number;
  /** Fade-out at end of cropped region in milliseconds. */
  fadeOutMs: number;
  fadeCurve: FadeCurve;
  reverse: boolean;
  dcOffsetRemove: boolean;
}

export const DEFAULT_SHAPER_SPEC: ShaperSpec = {
  trimStartMs: 0,
  trimEndMs: 0,
  gainDb: 0,
  normalizePeakDbfs: null,
  fadeInMs: 0,
  fadeOutMs: 0,
  fadeCurve: "cosine",
  reverse: false,
  dcOffsetRemove: false,
};

export type EqBandId = "hp" | "low" | "mid" | "high" | "lp";
export type EqSlope = 12 | 24 | 36 | 48;
export type EqToneType = "bell" | "shelf";

/** High-pass / low-pass band: Butterworth cut, 12-48 dB/oct. */
export interface EqCutBand {
  on: boolean;
  freqHz: number;
  slope: EqSlope;
}

/**
 * Low / mid / high band. `type` picks bell or shelf (low = low shelf,
 * high = high shelf); the mid band is always a bell.
 */
export interface EqToneBand {
  on: boolean;
  freqHz: number;
  /** Gain in dB (-18 to +18). */
  gainDb: number;
  q: number;
  type: EqToneType;
}

/** Five fixed bands in series: HP -> Low -> Mid -> High -> LP. */
export interface EqSpec {
  /** Global bypass: false skips every band (A/B against the dry sound). */
  on: boolean;
  hp: EqCutBand;
  low: EqToneBand;
  mid: EqToneBand;
  high: EqToneBand;
  lp: EqCutBand;
}

export const EQ_BAND_IDS: readonly EqBandId[] = ["hp", "low", "mid", "high", "lp"];
export const EQ_MIN_HZ = 20;
export const EQ_MAX_HZ = 20000;
export const EQ_MAX_GAIN_DB = 18;
export const EQ_MIN_Q = 0.3;
export const EQ_MAX_BELL_Q = 10;
/** Shelves above this Q overshoot into a bump/dip either side of the corner. */
export const EQ_MAX_SHELF_Q = 2;
export const EQ_SLOPES: readonly EqSlope[] = [12, 24, 36, 48];

export const DEFAULT_EQ_SPEC: EqSpec = {
  on: true,
  hp: { on: false, freqHz: 80, slope: 24 },
  low: { on: true, freqHz: 120, gainDb: 0, q: Math.SQRT1_2, type: "shelf" },
  mid: { on: true, freqHz: 1200, gainDb: 0, q: 1.0, type: "bell" },
  high: { on: true, freqHz: 4500, gainDb: 0, q: Math.SQRT1_2, type: "shelf" },
  lp: { on: false, freqHz: 16000, slope: 24 },
};

export function isCutBand(id: EqBandId): id is "hp" | "lp" {
  return id === "hp" || id === "lp";
}

export function eqQRange(band: EqToneBand): [number, number] {
  return [EQ_MIN_Q, band.type === "shelf" ? EQ_MAX_SHELF_Q : EQ_MAX_BELL_Q];
}

/** Clamp a band to its valid ranges (shared by drag, keyboard and typed values). */
export function clampToneBand(band: EqToneBand): EqToneBand {
  const [qMin, qMax] = eqQRange(band);
  return {
    ...band,
    freqHz: Math.max(EQ_MIN_HZ, Math.min(EQ_MAX_HZ, band.freqHz)),
    gainDb: Math.max(-EQ_MAX_GAIN_DB, Math.min(EQ_MAX_GAIN_DB, band.gainDb)),
    q: Math.max(qMin, Math.min(qMax, band.q)),
  };
}

export function clampCutBand(band: EqCutBand): EqCutBand {
  return {
    ...band,
    freqHz: Math.max(EQ_MIN_HZ, Math.min(EQ_MAX_HZ, band.freqHz)),
  };
}

/**
 * What double-clicking a band's node resets: tone bands go back to 0 dB
 * (frequency, Q and type kept), cut bands back to their default cutoff.
 */
export function zeroEqBand(spec: EqSpec, id: EqBandId): EqSpec {
  if (isCutBand(id)) {
    return { ...spec, [id]: { ...spec[id], freqHz: DEFAULT_EQ_SPEC[id].freqHz } };
  }
  return { ...spec, [id]: { ...spec[id], gainDb: 0 } };
}

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function makeHighpass(fc: number, sr: number, q = Math.SQRT1_2): BiquadCoeffs {
  const w0 = (2 * Math.PI * Math.max(10, Math.min(fc, sr * 0.48))) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = (1 + cos) / 2;
  const b1 = -(1 + cos);
  const b2 = (1 + cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function makeLowpass(fc: number, sr: number, q = Math.SQRT1_2): BiquadCoeffs {
  const w0 = (2 * Math.PI * Math.max(20, Math.min(fc, sr * 0.49))) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = (1 - cos) / 2;
  const b1 = 1 - cos;
  const b2 = (1 - cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function makeLowShelf(
  fc: number,
  gainDb: number,
  q: number,
  sr: number
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * Math.max(20, Math.min(fc, sr * 0.45))) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Math.max(0.1, q));
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  const b0 = A * (A + 1 - (A - 1) * cos + twoSqrtAAlpha);
  const b1 = 2 * A * (A - 1 - (A + 1) * cos);
  const b2 = A * (A + 1 - (A - 1) * cos - twoSqrtAAlpha);
  const a0 = A + 1 + (A - 1) * cos + twoSqrtAAlpha;
  const a1 = -2 * (A - 1 + (A + 1) * cos);
  const a2 = A + 1 + (A - 1) * cos - twoSqrtAAlpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function makeHighShelf(
  fc: number,
  gainDb: number,
  q: number,
  sr: number
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * Math.max(20, Math.min(fc, sr * 0.45))) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Math.max(0.1, q));
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  const b0 = A * (A + 1 + (A - 1) * cos + twoSqrtAAlpha);
  const b1 = -2 * A * (A - 1 + (A + 1) * cos);
  const b2 = A * (A + 1 + (A - 1) * cos - twoSqrtAAlpha);
  const a0 = A + 1 - (A - 1) * cos + twoSqrtAAlpha;
  const a1 = 2 * (A - 1 - (A + 1) * cos);
  const a2 = A + 1 - (A - 1) * cos - twoSqrtAAlpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function makePeaking(
  fc: number,
  gainDb: number,
  q: number,
  sr: number
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * Math.max(20, Math.min(fc, sr * 0.45))) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));
  const b0 = 1 + alpha * A;
  const b1 = -2 * cos;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cos;
  const a2 = 1 - alpha / A;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function applyBiquadInPlace(buf: Float32Array, c: BiquadCoeffs): void {
  const { b0, b1, b2, a1, a2 } = c;
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    buf[i] = y;
  }
}

function stagesResponseDb(
  stages: readonly BiquadCoeffs[],
  hz: number,
  sampleRate: number
): number {
  if (stages.length === 0) {
    return 0;
  }
  const w = (2 * Math.PI * hz) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);

  let totalMagSq = 1;
  for (const s of stages) {
    const nr = s.b0 + s.b1 * cos1 + s.b2 * cos2;
    const ni = -(s.b1 * sin1 + s.b2 * sin2);
    const dr = 1 + s.a1 * cos1 + s.a2 * cos2;
    const di = -(s.a1 * sin1 + s.a2 * sin2);
    const num = nr * nr + ni * ni;
    const den = Math.max(1e-12, dr * dr + di * di);
    totalMagSq *= num / den;
  }
  return 10 * Math.log10(Math.max(1e-6, totalMagSq));
}

/**
 * Evaluate the composite EQ magnitude response (in dB) at a given frequency `hz`
 * so the UI can draw an exact real-time response curve.
 */
export function evaluateEqResponseDb(
  spec: EqSpec,
  hz: number,
  sampleRate = 48000
): number {
  return stagesResponseDb(buildEqStages(spec, sampleRate), hz, sampleRate);
}

/** The composite response at many frequencies, building the stages once. */
export function eqResponseCurveDb(
  spec: EqSpec,
  freqsHz: ArrayLike<number>,
  sampleRate = 48000
): Float32Array {
  const stages = buildEqStages(spec, sampleRate);
  const out = new Float32Array(freqsHz.length);
  for (let i = 0; i < freqsHz.length; i++) {
    out[i] = stagesResponseDb(stages, freqsHz[i], sampleRate);
  }
  return out;
}

/**
 * Butterworth section Qs for an N-th order cut (N = slope / 6): a cascade of
 * N/2 biquads with these Qs gives a maximally flat passband at -3 dB on fc.
 */
function butterworthQs(slope: EqSlope): number[] {
  const order = slope / 6;
  const qs: number[] = [];
  for (let k = 1; k <= order / 2; k++) {
    qs.push(1 / (2 * Math.sin((Math.PI * (2 * k - 1)) / (2 * order))));
  }
  return qs;
}

function toneStage(
  id: "low" | "mid" | "high",
  band: EqToneBand,
  sampleRate: number
): BiquadCoeffs {
  if (band.type === "shelf" && id !== "mid") {
    return id === "low"
      ? makeLowShelf(band.freqHz, band.gainDb, band.q, sampleRate)
      : makeHighShelf(band.freqHz, band.gainDb, band.q, sampleRate);
  }
  return makePeaking(band.freqHz, band.gainDb, band.q, sampleRate);
}

/**
 * Switched-off bands, and tone bands at 0 dB, add no stage, so the default
 * spec yields none and the source passes through untouched.
 */
function buildEqStages(spec: EqSpec, sampleRate: number): BiquadCoeffs[] {
  const stages: BiquadCoeffs[] = [];
  if (!spec.on) {
    return stages;
  }
  if (spec.hp.on) {
    for (const q of butterworthQs(spec.hp.slope)) {
      stages.push(makeHighpass(spec.hp.freqHz, sampleRate, q));
    }
  }
  for (const id of ["low", "mid", "high"] as const) {
    const band = spec[id];
    if (band.on && Math.abs(band.gainDb) > 0.05) {
      stages.push(toneStage(id, band, sampleRate));
    }
  }
  if (spec.lp.on) {
    for (const q of butterworthQs(spec.lp.slope)) {
      stages.push(makeLowpass(spec.lp.freqHz, sampleRate, q));
    }
  }
  return stages;
}

/** Response of one band alone, ignoring its own and the global on switch. */
export function eqBandResponseCurveDb(
  spec: EqSpec,
  id: EqBandId,
  freqsHz: ArrayLike<number>,
  sampleRate = 48000
): Float32Array {
  const solo: EqSpec = {
    ...DEFAULT_EQ_SPEC,
    [id]: { ...spec[id], on: true },
  };
  return eqResponseCurveDb(solo, freqsHz, sampleRate);
}

export function isShaperActive(shaper: ShaperSpec): boolean {
  return (
    shaper.trimStartMs > 0 ||
    shaper.trimEndMs > 0 ||
    Math.abs(shaper.gainDb) > 0.01 ||
    shaper.normalizePeakDbfs !== null ||
    shaper.fadeInMs > 0 ||
    shaper.fadeOutMs > 0 ||
    shaper.reverse ||
    shaper.dcOffsetRemove
  );
}

/**
 * Scan the source audio from both ends to detect leading and trailing silence
 * below `thresholdDbfs` (default -50 dBFS), leaving a small natural safety pad.
 */
export function detectSilenceTrimMs(
  channels: readonly Float32Array[],
  sampleRate: number,
  thresholdDbfs = -50
): { trimStartMs: number; trimEndMs: number } {
  const len = channels[0]?.length ?? 0;
  if (len < 16 || channels.length === 0) {
    return { trimStartMs: 0, trimEndMs: 0 };
  }
  const thresh = Math.pow(10, thresholdDbfs / 20);
  const padSamples = Math.round(sampleRate * 0.006); // 6ms pre/post pad so onset isn't clipped

  let firstActive = 0;
  outerStart: for (let i = 0; i < len; i++) {
    for (let c = 0; c < channels.length; c++) {
      if (Math.abs(channels[c][i]) >= thresh) {
        firstActive = Math.max(0, i - padSamples);
        break outerStart;
      }
    }
  }

  let lastActive = len;
  outerEnd: for (let i = len - 1; i >= firstActive; i--) {
    for (let c = 0; c < channels.length; c++) {
      if (Math.abs(channels[c][i]) >= thresh) {
        lastActive = Math.min(len, i + 1 + padSamples);
        break outerEnd;
      }
    }
  }

  if (lastActive - firstActive < Math.round(sampleRate * 0.02)) {
    return { trimStartMs: 0, trimEndMs: 0 };
  }

  return {
    trimStartMs: Math.round((firstActive / sampleRate) * 1000),
    trimEndMs: Math.round(((len - lastActive) / sampleRate) * 1000),
  };
}

export function isEqActive(eq: EqSpec): boolean {
  return buildEqStages(eq, 48000).length > 0;
}

/**
 * Apply non-destructive Shaper + EQ stages to source channels.
 * If neither module is active, returns the original channel references without copying.
 */
export function applyDspChain(
  sourceChannels: readonly Float32Array[],
  sampleRate: number,
  shaper: ShaperSpec,
  eq: EqSpec
): Float32Array[] {
  const shaperOn = isShaperActive(shaper);
  const eqStages = buildEqStages(eq, sampleRate);
  if (!shaperOn && eqStages.length === 0) {
    return sourceChannels.slice();
  }

  const srcLen = sourceChannels[0]?.length ?? 0;
  let cropStart = 0;
  let cropEnd = srcLen;
  if (shaperOn && srcLen > 4) {
    const startSamples = Math.max(
      0,
      Math.round((shaper.trimStartMs / 1000) * sampleRate)
    );
    const endTrimSamples = Math.max(
      0,
      Math.round((shaper.trimEndMs / 1000) * sampleRate)
    );
    cropStart = Math.min(startSamples, srcLen - 4);
    cropEnd = Math.max(cropStart + 4, srcLen - endTrimSamples);
  }
  const len = cropEnd - cropStart;

  const out = sourceChannels.map((ch) => {
    const copy = new Float32Array(len);
    copy.set(ch.subarray(cropStart, cropEnd));
    return copy;
  });

  if (shaperOn && len > 0) {
    if (shaper.dcOffsetRemove) {
      for (const ch of out) {
        let sum = 0;
        for (let i = 0; i < len; i++) {
          sum += ch[i];
        }
        const mean = sum / len;
        if (Math.abs(mean) > 1e-6) {
          for (let i = 0; i < len; i++) {
            ch[i] -= mean;
          }
        }
      }
    }

    if (shaper.reverse) {
      for (const ch of out) {
        ch.reverse();
      }
    }
  }

  if (eqStages.length > 0 && len > 0) {
    for (const ch of out) {
      for (const stage of eqStages) {
        applyBiquadInPlace(ch, stage);
      }
    }
  }

  if (shaperOn && len > 0) {
    let scale = Math.pow(10, shaper.gainDb / 20);
    if (shaper.normalizePeakDbfs !== null) {
      let peak = 0;
      for (const ch of out) {
        for (let i = 0; i < len; i++) {
          const a = Math.abs(ch[i]);
          if (a > peak) {
            peak = a;
          }
        }
      }
      if (peak > 1e-6) {
        const targetLinear = Math.pow(10, shaper.normalizePeakDbfs / 20);
        scale *= targetLinear / peak;
      }
    }

    if (Math.abs(scale - 1) > 1e-4) {
      for (const ch of out) {
        for (let i = 0; i < len; i++) {
          ch[i] *= scale;
        }
      }
    }

    const fadeInSamples = Math.min(
      len,
      Math.max(0, Math.round((shaper.fadeInMs / 1000) * sampleRate))
    );
    if (fadeInSamples > 1) {
      for (const ch of out) {
        for (let i = 0; i < fadeInSamples; i++) {
          const t = (i + 0.5) / fadeInSamples;
          ch[i] *= fadeInGain(shaper.fadeCurve, t);
        }
      }
    }

    const fadeOutSamples = Math.min(
      len,
      Math.max(0, Math.round((shaper.fadeOutMs / 1000) * sampleRate))
    );
    if (fadeOutSamples > 1) {
      const startIdx = len - fadeOutSamples;
      for (const ch of out) {
        for (let i = 0; i < fadeOutSamples; i++) {
          const t = (i + 0.5) / fadeOutSamples;
          ch[startIdx + i] *= fadeOutGain(shaper.fadeCurve, t);
        }
      }
    }
  }

  return out;
}

export interface SignalStats {
  peakDbfs: number;
  rmsDbfs: number;
  crestDb: number;
}

export function measureSignalStats(
  channels: readonly Float32Array[],
  startSample = 0,
  endSample?: number
): SignalStats {
  const nCh = channels.length;
  const len = channels[0]?.length ?? 0;
  const s0 = Math.max(0, Math.min(Math.floor(startSample), len));
  const s1 = Math.max(s0, Math.min(Math.floor(endSample ?? len), len));
  const count = s1 - s0;
  if (nCh === 0 || count <= 0) {
    return { peakDbfs: -120, rmsDbfs: -120, crestDb: 0 };
  }
  let peak = 0;
  let sumSq = 0;
  for (const ch of channels) {
    for (let i = s0; i < s1; i++) {
      const v = ch[i];
      const a = Math.abs(v);
      if (a > peak) {
        peak = a;
      }
      sumSq += v * v;
    }
  }
  const rms = Math.sqrt(sumSq / (count * nCh));
  const peakDbfs = peak > 1e-6 ? 20 * Math.log10(peak) : -120;
  const rmsDbfs = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
  const crestDb = Math.max(0, peakDbfs - rmsDbfs);
  return { peakDbfs, rmsDbfs, crestDb };
}
