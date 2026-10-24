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
  enabled: boolean;
  /** Output gain in dB (-24 to +24). */
  gainDb: number;
  /** Target peak normalization in dBFS (null = off, e.g. -1.0 dBFS). */
  normalizePeakDbfs: number | null;
  /** Fade-in at start of region in milliseconds. */
  fadeInMs: number;
  /** Fade-out at end of region in milliseconds. */
  fadeOutMs: number;
  fadeCurve: FadeCurve;
  reverse: boolean;
  dcOffsetRemove: boolean;
}

export const DEFAULT_SHAPER_SPEC: ShaperSpec = {
  enabled: false,
  gainDb: 0,
  normalizePeakDbfs: null,
  fadeInMs: 0,
  fadeOutMs: 0,
  fadeCurve: "cosine",
  reverse: false,
  dcOffsetRemove: false,
};

export interface EqSpec {
  enabled: boolean;
  /** High-pass cutoff Hz (20 = off, up to 2000 Hz). */
  highpassHz: number;
  /** Low shelf @ 120 Hz in dB (-18 to +18). */
  lowGainDb: number;
  /** Peaking mid band gain in dB (-18 to +18). */
  midGainDb: number;
  /** Peaking mid center frequency in Hz (200 to 6000). */
  midFreqHz: number;
  /** Peaking mid Q factor (0.4 to 6.0). */
  midQ: number;
  /** High shelf @ 4500 Hz in dB (-18 to +18). */
  highGainDb: number;
  /** Low-pass cutoff Hz (20000 = off, down to 400 Hz). */
  lowpassHz: number;
}

export const DEFAULT_EQ_SPEC: EqSpec = {
  enabled: false,
  highpassHz: 20,
  lowGainDb: 0,
  midGainDb: 0,
  midFreqHz: 1200,
  midQ: 1.0,
  highGainDb: 0,
  lowpassHz: 20000,
};

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

function makeLowShelf(fc: number, gainDb: number, sr: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * Math.max(20, Math.min(fc, sr * 0.45))) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = (sin / 2) * Math.sqrt(2);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  const b0 = A * (A + 1 - (A - 1) * cos + twoSqrtAAlpha);
  const b1 = 2 * A * (A - 1 - (A + 1) * cos);
  const b2 = A * (A + 1 - (A - 1) * cos - twoSqrtAAlpha);
  const a0 = A + 1 + (A - 1) * cos + twoSqrtAAlpha;
  const a1 = -2 * (A - 1 + (A + 1) * cos);
  const a2 = A + 1 + (A - 1) * cos - twoSqrtAAlpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function makeHighShelf(fc: number, gainDb: number, sr: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * Math.max(40, Math.min(fc, sr * 0.45))) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = (sin / 2) * Math.sqrt(2);
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
  const w0 = (2 * Math.PI * Math.max(40, Math.min(fc, sr * 0.45))) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(0.2, q));
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

/**
 * Evaluate the composite EQ magnitude response (in dB) at a given frequency `hz`
 * so the UI can draw an exact real-time response curve.
 */
export function evaluateEqResponseDb(
  spec: EqSpec,
  hz: number,
  sampleRate = 48000
): number {
  const stages = buildEqStages(spec, sampleRate);
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

function buildEqStages(spec: EqSpec, sampleRate: number): BiquadCoeffs[] {
  if (!spec.enabled) {
    return [];
  }
  const stages: BiquadCoeffs[] = [];
  if (spec.highpassHz > 22) {
    stages.push(makeHighpass(spec.highpassHz, sampleRate));
  }
  if (Math.abs(spec.lowGainDb) > 0.05) {
    stages.push(makeLowShelf(120, spec.lowGainDb, sampleRate));
  }
  if (Math.abs(spec.midGainDb) > 0.05) {
    stages.push(
      makePeaking(spec.midFreqHz, spec.midGainDb, spec.midQ, sampleRate)
    );
  }
  if (Math.abs(spec.highGainDb) > 0.05) {
    stages.push(makeHighShelf(4500, spec.highGainDb, sampleRate));
  }
  if (spec.lowpassHz < 19500) {
    stages.push(makeLowpass(spec.lowpassHz, sampleRate));
  }
  return stages;
}

export function isShaperActive(shaper: ShaperSpec): boolean {
  if (!shaper.enabled) {
    return false;
  }
  return (
    Math.abs(shaper.gainDb) > 0.01 ||
    shaper.normalizePeakDbfs !== null ||
    shaper.fadeInMs > 0 ||
    shaper.fadeOutMs > 0 ||
    shaper.reverse ||
    shaper.dcOffsetRemove
  );
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

  const len = sourceChannels[0]?.length ?? 0;
  const out = sourceChannels.map((ch) => {
    const copy = new Float32Array(ch.length);
    copy.set(ch);
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
