/**
 * Magnitude spectra for the EQ display. Only the EQ's input is analysed: the
 * output is drawn as input + EQ response, which is exact for a linear filter
 * in steady state and follows a node drag without re-rendering any audio.
 */

export const SPECTRUM_FFT_SIZE = 4096;

/** In-place iterative radix-2 FFT; `re.length` must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const hannCache = new Map<number, Float64Array>();
function hann(n: number): Float64Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    }
    hannCache.set(n, w);
  }
  return w;
}

/**
 * Add the power spectrum of one Hann-windowed, mono-summed frame starting at
 * `start` into `acc` (fftSize / 2 bins, linear power re full scale).
 */
function accumulateFramePower(
  channels: readonly Float32Array[],
  start: number,
  fftSize: number,
  acc: Float64Array
): void {
  const win = hann(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const len = channels[0]?.length ?? 0;
  const nCh = Math.max(1, channels.length);
  for (let i = 0; i < fftSize; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= len) {
      continue;
    }
    let v = 0;
    for (const ch of channels) {
      v += ch[idx];
    }
    re[i] = (v / nCh) * win[i];
  }
  fft(re, im);
  // A full-scale sine reads 0 dB: amplitude = 2|X| / sum(window).
  const norm = 2 / (fftSize * 0.5);
  for (let k = 0; k < fftSize / 2; k++) {
    const mag = Math.hypot(re[k], im[k]) * norm;
    acc[k] += mag * mag;
  }
}

function powerToDb(acc: Float64Array, frames: number): Float32Array {
  const out = new Float32Array(acc.length);
  for (let k = 0; k < acc.length; k++) {
    out[k] = 10 * Math.log10(Math.max(1e-14, acc[k] / Math.max(1, frames)));
  }
  return out;
}

/**
 * Long-term average spectrum (dBFS per FFT bin) of [start, end), from up to
 * `maxFrames` evenly spaced frames, for the display while playback is stopped.
 */
export function averageSpectrumDb(
  channels: readonly Float32Array[],
  start: number,
  end: number,
  fftSize = SPECTRUM_FFT_SIZE,
  maxFrames = 96
): Float32Array {
  const acc = new Float64Array(fftSize / 2);
  const span = Math.max(0, end - start);
  if (channels.length === 0 || span === 0) {
    return powerToDb(acc, 1);
  }
  const room = Math.max(0, span - fftSize);
  const frames = Math.max(1, Math.min(maxFrames, Math.ceil(span / (fftSize / 2))));
  for (let f = 0; f < frames; f++) {
    const offset = frames === 1 ? 0 : Math.round((room * f) / (frames - 1));
    accumulateFramePower(channels, start + offset, fftSize, acc);
  }
  return powerToDb(acc, frames);
}

/** Spectrum (dBFS per bin) of the frame centred on `center`, for the live display. */
export function frameSpectrumDb(
  channels: readonly Float32Array[],
  center: number,
  fftSize = SPECTRUM_FFT_SIZE
): Float32Array {
  const acc = new Float64Array(fftSize / 2);
  accumulateFramePower(channels, Math.round(center - fftSize / 2), fftSize, acc);
  return powerToDb(acc, 1);
}

/**
 * Resample per-bin dB onto display frequencies, averaging power over a
 * 1/6-octave window so the high end reads as a curve rather than a comb.
 */
export function binsToCurveDb(
  binsDb: Float32Array,
  sampleRate: number,
  freqsHz: ArrayLike<number>,
  fftSize = SPECTRUM_FFT_SIZE
): Float32Array {
  const out = new Float32Array(freqsHz.length);
  const binHz = sampleRate / fftSize;
  const half = Math.pow(2, 1 / 12);
  for (let i = 0; i < freqsHz.length; i++) {
    const f = freqsHz[i];
    const lo = Math.max(1, Math.floor(f / half / binHz));
    const hi = Math.min(binsDb.length - 1, Math.ceil((f * half) / binHz));
    let sum = 0;
    let n = 0;
    for (let k = lo; k <= hi; k++) {
      sum += Math.pow(10, binsDb[k] / 10);
      n++;
    }
    out[i] = n > 0 ? 10 * Math.log10(Math.max(1e-14, sum / n)) : -140;
  }
  return out;
}
