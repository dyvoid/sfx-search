/**
 * Automatic loop-point search (ADR 0004).
 *
 * Coarse stage: a three-band RMS envelope at 10 ms hops over the whole file.
 * For every candidate loop start `i`, score the normalized cross-correlation
 * between the feature window *preceding* `i` and the window *preceding* the
 * loop end `E`. Matching run-ups make the E->S transition sound continuous.
 *
 * Fine stage: for the best coarse candidates, sample-level NCC on a decimated
 * low-passed signal within +/- fineSearchMs, then snap to a zero crossing.
 */

import { snapToZeroCrossing } from "./loopdsp";

export interface SearchOptions {
  /** Loop end in samples (exclusive). Defaults to end of file. */
  loopEnd?: number;
  /** Minimum loop length in samples. Default 2 s. */
  minLoopLength?: number;
  /** Maximum loop length in samples (optional). */
  maxLoopLength?: number;
  /** Comparison window length, milliseconds. Default 400. */
  windowMs?: number;
  /** Number of candidates to return. Default 8. */
  topN?: number;
  /** Fine-alignment search radius, milliseconds. Default 150. */
  fineSearchMs?: number;
  /** Minimum separation between returned candidates, ms. Default 300. */
  separationMs?: number;
}

export interface LoopCandidate {
  /** Loop start in samples. */
  start: number;
  /** Loop end in samples. */
  end: number;
  /** Combined score in [0, 1]. */
  score: number;
}

const HOP_MS = 10;
const BAND_SPLIT_HZ = 1000;
const DECIMATE = 8;
const COARSE_SHORTLIST = 60;
/** Target size of the subsampled grid for pair search — bounds the O(n·lag) scan. */
const PAIR_GRID_TARGET = 4000;

export function monoMix(channels: readonly Float32Array[]): Float32Array {
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  const inv = 1 / Math.max(1, channels.length);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      out[i] += ch[i] * inv;
    }
  }
  return out;
}

function lowpassSignal(
  x: Float32Array,
  sampleRate: number,
  fc: number
): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate);
  const out = new Float32Array(x.length);
  let lp = 0;
  for (let i = 0; i < x.length; i++) {
    lp += a * (x[i] - lp);
    out[i] = lp;
  }
  return out;
}

function decimate(x: Float32Array, k: number): Float32Array {
  const n = Math.floor(x.length / k);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * k;
    for (let j = 0; j < k; j++) {
      s += x[base + j];
    }
    out[i] = s / k;
  }
  return out;
}

/** Normalized cross-correlation of a[aOff..aOff+w) with b[bOff..bOff+w). */
function ncc(
  a: Float32Array,
  aOff: number,
  b: Float32Array,
  bOff: number,
  w: number
): number {
  let sAB = 0;
  let sAA = 0;
  let sBB = 0;
  for (let i = 0; i < w; i++) {
    const x = a[aOff + i];
    const y = b[bOff + i];
    sAB += x * y;
    sAA += x * x;
    sBB += y * y;
  }
  const d = Math.sqrt(sAA * sBB);
  return d > 1e-12 ? sAB / d : 0;
}

interface Bands {
  hop: number;
  frames: number;
  rms: Float32Array;
  low: Float32Array;
  high: Float32Array;
}

/** Per-hop RMS of the full signal, a <1 kHz band, and the remainder. */
function envelope(mono: Float32Array, sampleRate: number): Bands {
  const hop = Math.max(8, Math.round((sampleRate * HOP_MS) / 1000));
  const frames = Math.floor(mono.length / hop);
  const a = 1 - Math.exp((-2 * Math.PI * BAND_SPLIT_HZ) / sampleRate);
  const rms = new Float32Array(frames);
  const low = new Float32Array(frames);
  const high = new Float32Array(frames);
  let lp = 0;
  let rAcc = 0;
  let lAcc = 0;
  let hAcc = 0;
  let k = 0;
  let f = 0;
  for (let i = 0; i < mono.length && f < frames; i++) {
    const x = mono[i];
    lp += a * (x - lp);
    const h = x - lp;
    rAcc += x * x;
    lAcc += lp * lp;
    hAcc += h * h;
    if (++k === hop) {
      const inv = 1 / hop;
      rms[f] = Math.sqrt(rAcc * inv);
      low[f] = Math.sqrt(lAcc * inv);
      high[f] = Math.sqrt(hAcc * inv);
      rAcc = lAcc = hAcc = 0;
      k = 0;
      f++;
    }
  }
  return { hop, frames, rms, low, high };
}

/**
 * Search `mono` for loop-start positions that loop seamlessly into `loopEnd`.
 * Returns up to `topN` candidates sorted by descending score.
 */
export function findLoopPoints(
  mono: Float32Array,
  sampleRate: number,
  options: SearchOptions = {},
  onProgress?: (frac: number) => void
): LoopCandidate[] {
  const len = mono.length;
  const loopEnd = Math.min(Math.floor(options.loopEnd ?? len), len);
  const minLoop = Math.floor(options.minLoopLength ?? 2 * sampleRate);
  const maxLoop = options.maxLoopLength
    ? Math.floor(options.maxLoopLength)
    : len;
  const windowMs = options.windowMs ?? 400;
  const topN = options.topN ?? 8;
  const fineSearchMs = options.fineSearchMs ?? 150;
  const separationMs = options.separationMs ?? 300;

  const env = envelope(mono, sampleRate);
  const { hop, frames } = env;
  const w = Math.max(3, Math.round(windowMs / HOP_MS));
  const e = Math.min(Math.floor(loopEnd / hop), frames);
  const minLoopHop = Math.ceil(minLoop / hop);
  const maxLoopHop = Math.ceil(maxLoop / hop);

  // Window before i must fit, windows must not overlap, loop must be in [minLoop, maxLoop].
  const iMin = Math.max(w, e - maxLoopHop);
  const iMax = Math.min(e - 2 * w, e - minLoopHop);
  if (iMax <= iMin || e - w < w) {
    onProgress?.(1);
    return [];
  }

  const streams = [env.rms, env.low, env.high];
  const refOff = e - w;

  const coarse = new Float32Array(iMax + 1);
  for (let i = iMin; i <= iMax; i++) {
    let s = 0;
    for (const st of streams) {
      s += ncc(st, i - w, st, refOff, w);
    }
    coarse[i] = s / streams.length;
    if ((i & 1023) === 0) {
      onProgress?.((0.6 * (i - iMin)) / (iMax - iMin));
    }
  }

  // Shortlist with hop-domain non-maximum suppression.
  const sepHop = Math.max(1, Math.round(separationMs / HOP_MS));
  const order = Array.from({ length: iMax + 1 - iMin }, (_, j) => iMin + j).sort(
    (a, b) => coarse[b] - coarse[a]
  );
  const shortlist: number[] = [];
  for (const idx of order) {
    if (shortlist.every((j) => Math.abs(j - idx) > sepHop)) {
      shortlist.push(idx);
    }
    if (shortlist.length >= COARSE_SHORTLIST) {
      break;
    }
  }

  // Fine alignment on a decimated, band-limited version of the signal.
  const low = lowpassSignal(mono, sampleRate, BAND_SPLIT_HZ);
  const dec = decimate(low, DECIMATE);
  const wDec = Math.max(
    8,
    Math.round((Math.min(windowMs, 300) * sampleRate) / 1000 / DECIMATE)
  );
  const refD = Math.floor(loopEnd / DECIMATE) - wDec;
  const radius = Math.round((fineSearchMs * sampleRate) / 1000 / DECIMATE);
  const snapRange = Math.round((30 * sampleRate) / 1000);

  const results: LoopCandidate[] = [];
  shortlist.forEach((iHop, n) => {
    const baseD = Math.floor((iHop * hop) / DECIMATE);
    let bestO = 0;
    let bestC = -2;
    for (let o = -radius; o <= radius; o++) {
      const p = baseD - wDec + o;
      if (
        p < 0 ||
        refD < 0 ||
        p + wDec > dec.length ||
        refD + wDec > dec.length
      ) {
        continue;
      }
      const c = ncc(dec, p, dec, refD, wDec);
      if (c > bestC) {
        bestC = c;
        bestO = o;
      }
    }
    let start = iHop * hop + bestO * DECIMATE;
    start = snapToZeroCrossing(mono, start, snapRange, "rising");
    const score = Math.max(0, Math.min(1, (coarse[iHop] + bestC + 2) / 4));
    results.push({
      start: Math.max(0, Math.min(start, len - 2)),
      end: loopEnd,
      score,
    });
    onProgress?.(0.6 + 0.4 * (n / Math.max(1, shortlist.length)));
  });

  // Final suppression in the sample domain, best score first.
  results.sort((a, b) => b.score - a.score);
  const sepS = Math.round((separationMs * sampleRate) / 1000);
  const picked: LoopCandidate[] = [];
  for (const c of results) {
    if (picked.every((r) => Math.abs(r.start - c.start) > sepS)) {
      picked.push(c);
    }
    if (picked.length >= topN) {
      break;
    }
  }
  onProgress?.(1);
  return picked;
}

/**
 * Full pair search: both the loop start AND end are free variables.
 * Scans every (i, j) pair on a subsampled hop grid — for each lag L = j-i the
 * windowed dot product slides in O(1) per i — then fine-aligns both points of
 * each shortlisted pair.
 */
export function findLoopPairs(
  mono: Float32Array,
  sampleRate: number,
  options: SearchOptions = {},
  onProgress?: (frac: number) => void
): LoopCandidate[] {
  const len = mono.length;
  const minLoop = Math.floor(options.minLoopLength ?? 2 * sampleRate);
  const maxLoop = options.maxLoopLength
    ? Math.floor(options.maxLoopLength)
    : len;
  const windowMs = options.windowMs ?? 400;
  const topN = options.topN ?? 8;
  const fineSearchMs = options.fineSearchMs ?? 150;
  const separationMs = options.separationMs ?? 300;

  const env = envelope(mono, sampleRate);
  const { hop, frames } = env;

  // Subsample the hop grid so the pair scan stays O(n·lag) at a bounded n.
  const sub = Math.max(1, Math.round(frames / PAIR_GRID_TARGET));
  const grid = Math.floor(frames / sub);
  const w = Math.max(3, Math.round(windowMs / (HOP_MS * sub)));
  const minLag = Math.max(w, Math.ceil(minLoop / (hop * sub)));
  const maxLag = Math.min(grid - 1, Math.ceil(maxLoop / (hop * sub)));
  if (grid < w + minLag + 2 || maxLag < minLag) {
    onProgress?.(1);
    return [];
  }

  const subs = [env.rms, env.low, env.high].map((st) => {
    const out = new Float32Array(grid);
    for (let i = 0; i < grid; i++) {
      out[i] = st[i * sub];
    }
    return out;
  });

  // Per-index energy of the window ending at i (sliding accumulation).
  const norms = subs.map((st) => {
    const nm = new Float32Array(grid);
    let acc = 0;
    for (let i = 0; i < grid; i++) {
      acc += st[i] * st[i];
      if (i - w >= 0) {
        acc -= st[i - w] * st[i - w];
      }
      nm[i] = Math.sqrt(Math.max(0, acc));
    }
    return nm;
  });

  // For every start i, keep the end j that best matches its run-up window.
  const bestScore = new Float32Array(grid).fill(-2);
  const bestJ = new Int32Array(grid);
  const i0 = w - 1;
  for (let L = minLag; L <= maxLag; L++) {
    const j0 = i0 + L;
    const dots = [0, 0, 0];
    for (let q = 0; q < w; q++) {
      for (let s = 0; s < 3; s++) {
        dots[s] += subs[s][i0 - q] * subs[s][j0 - q];
      }
    }
    for (let i = i0; i + L < grid; i++) {
      const j = i + L;
      if (i > i0) {
        for (let s = 0; s < 3; s++) {
          dots[s] += subs[s][i] * subs[s][j] - subs[s][i - w] * subs[s][j - w];
        }
      }
      let sc = 0;
      for (let s = 0; s < 3; s++) {
        const den = norms[s][i] * norms[s][j];
        if (den > 1e-9) {
          sc += dots[s] / den;
        }
      }
      sc /= 3;
      if (sc > bestScore[i]) {
        bestScore[i] = sc;
        bestJ[i] = j;
      }
    }
    if ((L & 63) === 0) {
      onProgress?.(0.05 + (0.55 * L) / Math.max(1, maxLag));
    }
  }

  // Shortlist: suppress nearby starts, keep the best per region.
  const order = Array.from({ length: grid - i0 }, (_, k) => i0 + k)
    .filter((i) => bestScore[i] > -2)
    .sort((a, b) => bestScore[b] - bestScore[a]);
  const sepGrid = Math.max(1, Math.round(separationMs / (HOP_MS * sub)));
  const shortlist: Array<{ i: number; j: number; coarse: number }> = [];
  for (const i of order) {
    if (shortlist.every((c) => Math.abs(c.i - i) > sepGrid)) {
      shortlist.push({ i, j: bestJ[i], coarse: bestScore[i] });
    }
    if (shortlist.length >= COARSE_SHORTLIST) {
      break;
    }
  }

  // Fine-align both ends of each pair on the decimated low-band signal.
  const low = lowpassSignal(mono, sampleRate, BAND_SPLIT_HZ);
  const dec = decimate(low, DECIMATE);
  const wDec = Math.max(
    8,
    Math.round((Math.min(windowMs, 300) * sampleRate) / 1000 / DECIMATE)
  );
  const radius = Math.round((fineSearchMs * sampleRate) / 1000 / DECIMATE);
  const snapRange = Math.round((30 * sampleRate) / 1000);

  const align = (
    probeOff: number,
    refOff: number,
    radiusS: number
  ): { offset: number; corr: number } => {
    let bestO = 0;
    let bestC = -2;
    for (let o = -radiusS; o <= radiusS; o++) {
      const p = probeOff + o;
      if (
        p < 0 ||
        refOff < 0 ||
        p + wDec > dec.length ||
        refOff + wDec > dec.length
      ) {
        continue;
      }
      const c = ncc(dec, p, dec, refOff, wDec);
      if (c > bestC) {
        bestC = c;
        bestO = o;
      }
    }
    return { offset: bestO, corr: bestC };
  };

  const results: LoopCandidate[] = [];
  shortlist.forEach(({ i, j, coarse }, n) => {
    let iD = Math.floor((i * sub * hop) / DECIMATE) - wDec;
    const jD = Math.floor((j * sub * hop) / DECIMATE) - wDec;
    const a1 = align(iD, jD, radius);
    iD += a1.offset;
    const a2 = align(jD, iD, radius);
    const fine = (a1.corr + a2.corr) / 2;
    let start = i * sub * hop + a1.offset * DECIMATE;
    let end = j * sub * hop + a2.offset * DECIMATE;
    start = snapToZeroCrossing(mono, start, snapRange, "rising");
    end = snapToZeroCrossing(mono, end, snapRange, "any");
    const score = Math.max(0, Math.min(1, (coarse + fine + 2) / 4));
    if (end - start >= Math.min(minLoop, 1000)) {
      results.push({
        start: Math.max(0, start),
        end: Math.min(end, len),
        score,
      });
    }
    onProgress?.(0.6 + 0.4 * (n / Math.max(1, shortlist.length)));
  });

  results.sort((a, b) => b.score - a.score);
  const sepS = Math.round((separationMs * sampleRate) / 1000);
  const picked: LoopCandidate[] = [];
  for (const c of results) {
    if (picked.every((r) => Math.abs(r.start - c.start) > sepS)) {
      picked.push(c);
    }
    if (picked.length >= topN) {
      break;
    }
  }
  onProgress?.(1);
  return picked;
}
