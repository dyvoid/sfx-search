import React, { useEffect, useImperativeHandle, useRef } from "react";

export interface LoopMarkers {
  start: number;
  end: number;
  /** Crossfade length in samples. */
  fade: number;
  /** True when the fade region sits after loop start (post-roll mode). */
  fadeAtHead: boolean;
  /** Optional custom handle labels (default 'S' and 'E'; 'IN' and 'OUT' in crop mode). */
  startLabel?: string;
  endLabel?: string;
  /** Optional boundary fade-in / fade-out lengths in samples (for Trim & Gain visualization). */
  fadeInSamples?: number;
  fadeOutSamples?: number;
}

export interface CandidateBand {
  start: number;
  end: number;
  score: number;
}

export interface EditorWaveformHandle {
  resetView: () => void;
  zoomToLoop: () => void;
  zoomToSeam: () => void;
  zoomByFactor: (factor: number) => void;
  setPlayhead: (sample: number | null) => void;
}

interface EditorWaveformProps {
  channels: Float32Array[] | null;
  sampleRate: number;
  loop: LoopMarkers | null;
  activeMarker: "start" | "end";
  onLoopChange: (start: number, end: number) => void;
  onSeek: (sample: number) => void;
  onSelectMarker?: (marker: "start" | "end") => void;
}

const OVERVIEW_BUCKETS = 4096;
const MIN_VIEW_SAMPLES = 256;
const MARKER_HIT_PX = 9;
const RULER_H = 22;

const TICK_STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 1800,
];
const TICK_MIN_PX = 68;

const COLOR_VARS = {
  wave: "--accent-2-400",
  grid: "--border-subtle",
  start: "--success-500",
  end: "--danger-400",
  clip: "--danger-500",
  fade: "--accent-1-muted-bg",
  fadeLabel: "--accent-1-400",
  outsideLoop: "--scrim",
  candidate: "--accent-3-muted-bg",
  candidateActive: "oklch(from var(--accent-3-seed) l c h / 0.40)",
  playhead: "--text-primary",
  legend: "--text-secondary",
  rulerBg: "--surface-panel",
  hover: "--border-strong",
  pillBg: "oklch(from var(--gray-950) l c h / 0.85)",
} as const;

type ColorName = keyof typeof COLOR_VARS;
type Palette = Record<ColorName, string>;

const FALLBACKS: Palette = {
  wave: "#58b5c9",
  grid: "rgba(255, 255, 255, 0.10)",
  start: "#45c486",
  end: "#eb6565",
  clip: "#e04848",
  fade: "rgba(224, 178, 82, 0.20)",
  fadeLabel: "#e6b85c",
  outsideLoop: "rgba(8, 9, 14, 0.62)",
  candidate: "rgba(226, 122, 184, 0.14)",
  candidateActive: "rgba(226, 122, 184, 0.40)",
  playhead: "rgba(255, 255, 255, 0.92)",
  legend: "rgba(215, 222, 234, 0.78)",
  rulerBg: "rgba(20, 22, 30, 0.85)",
  hover: "rgba(255, 255, 255, 0.22)",
  pillBg: "rgba(12, 14, 20, 0.85)",
};

let resolvedPalette: Palette | null = null;

function resolvePalette(): Palette {
  if (resolvedPalette) {
    return resolvedPalette;
  }
  const probe = document.createElement("div");
  document.body.appendChild(probe);
  const out = { ...FALLBACKS };
  for (const name of Object.keys(COLOR_VARS) as ColorName[]) {
    const spec: string = COLOR_VARS[name];
    probe.style.color = ""; // never inherit the previous entry on a rejected value
    probe.style.color = spec.startsWith("--")
      ? `var(${spec}, ${FALLBACKS[name]})`
      : spec;
    if (!probe.style.color) {
      continue; // unsupported syntax: keep the fallback, not the inherited color
    }
    const v = getComputedStyle(probe).color;
    out[name] = v || FALLBACKS[name];
  }
  probe.remove();
  resolvedPalette = out;
  return out;
}

interface PeakCache {
  from: number;
  to: number;
  buckets: number;
  mins: Float32Array[];
  maxs: Float32Array[];
}

function fmtTick(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (m > 0) {
    if (step < 1) {
      return `${m}:${s.toFixed(2).padStart(5, "0")}`;
    }
    if (step < 60) {
      return `${m}:${s.toFixed(1).padStart(4, "0")}`;
    }
    return `${m}:${String(Math.round(s)).padStart(2, "0")}`;
  }
  if (step < 0.01) {
    return `${s.toFixed(3)}s`;
  }
  if (step < 1) {
    return `${s.toFixed(2)}s`;
  }
  if (step < 60) {
    return `${s.toFixed(1)}s`;
  }
  return `${Math.round(s)}s`;
}

function peaksFor(
  ch: Float32Array,
  from: number,
  to: number,
  buckets: number
): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const span = to - from;
  for (let b = 0; b < buckets; b++) {
    const a = Math.max(0, from + Math.floor((b * span) / buckets));
    const c = Math.min(ch.length, from + Math.floor(((b + 1) * span) / buckets));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = a; i < c; i++) {
      const v = ch[i];
      if (v < lo) {
        lo = v;
      }
      if (v > hi) {
        hi = v;
      }
    }
    min[b] = lo === Infinity ? 0 : lo;
    max[b] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}

export const EditorWaveform = React.forwardRef<
  EditorWaveformHandle,
  EditorWaveformProps
>(
  (
    {
      channels,
      sampleRate,
      loop,
      activeMarker,
      onLoopChange,
      onSeek,
      onSelectMarker,
    },
    ref
  ) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    const stateRef = useRef<{
      channels: Float32Array[];
      length: number;
      sampleRate: number;
      pad: number;
      viewStart: number;
      viewEnd: number;
      loop: LoopMarkers | null;
      activeMarker: "start" | "end";
      playhead: number | null;
      overview: { mins: Float32Array[]; maxs: Float32Array[] } | null;
      peakCache: PeakCache | null;
      dragging: "start" | "end" | null;
      panning: boolean;
      lastX: number;
      downX: number;
      hoverSample: number | null;
    }>({
      channels: [],
      length: 0,
      sampleRate: 48000,
      pad: 0,
      viewStart: 0,
      viewEnd: 1,
      loop: null,
      activeMarker: "start",
      playhead: null,
      overview: null,
      peakCache: null,
      dragging: null,
      panning: false,
      lastX: 0,
      downX: 0,
      hoverSample: null,
    });

    const callbacksRef = useRef({
      onLoopChange,
      onSeek,
      onSelectMarker,
    });
    callbacksRef.current = {
      onLoopChange,
      onSeek,
      onSelectMarker,
    };

    const renderRef = useRef<() => void>(() => {});

    useEffect(() => {
      const cv = canvasRef.current;
      if (!cv) {
        return;
      }
      const st = stateRef.current;

      const width = () => cv.clientWidth || 1;
      const height = () => cv.clientHeight || 1;
      const pxToSample = (px: number) =>
        st.viewStart + (px / width()) * (st.viewEnd - st.viewStart);
      const sampleToPx = (s: number) =>
        ((s - st.viewStart) / (st.viewEnd - st.viewStart)) * width();

      const clampView = () => {
        const lo = -st.pad;
        const hi = st.length + st.pad;
        let w = st.viewEnd - st.viewStart;
        w = Math.max(MIN_VIEW_SAMPLES, Math.min(w, hi - lo));
        if (st.viewStart < lo) {
          st.viewStart = lo;
        }
        if (st.viewStart + w > hi) {
          st.viewStart = hi - w;
        }
        if (st.viewStart < lo) {
          st.viewStart = lo;
        }
        st.viewEnd = st.viewStart + w;
      };

      const visiblePeaks = (): PeakCache => {
        const buckets = Math.max(64, Math.floor(width()));
        const from = Math.floor(st.viewStart);
        const to = Math.ceil(st.viewEnd);
        const c = st.peakCache;
        if (c && c.from === from && c.to === to && c.buckets === buckets) {
          return c;
        }

        const samplesPerBucket = (to - from) / buckets;
        const overviewBucket = Math.max(1, st.length / OVERVIEW_BUCKETS);
        const mins: Float32Array[] = [];
        const maxs: Float32Array[] = [];

        for (const [ci, ch] of st.channels.slice(0, 2).entries()) {
          if (samplesPerBucket >= overviewBucket && st.overview) {
            const oMin = st.overview.mins[ci];
            const oMax = st.overview.maxs[ci];
            const min = new Float32Array(buckets);
            const max = new Float32Array(buckets);
            for (let b = 0; b < buckets; b++) {
              const a = from + (b * (to - from)) / buckets;
              const d = from + ((b + 1) * (to - from)) / buckets;
              const oa = Math.max(
                0,
                Math.floor((a / st.length) * OVERVIEW_BUCKETS)
              );
              const ob = Math.min(
                OVERVIEW_BUCKETS - 1,
                Math.floor((d / st.length) * OVERVIEW_BUCKETS)
              );
              let lo = Infinity;
              let hi = -Infinity;
              for (let j = oa; j <= ob; j++) {
                if (oMin[j] < lo) {
                  lo = oMin[j];
                }
                if (oMax[j] > hi) {
                  hi = oMax[j];
                }
              }
              min[b] = lo === Infinity ? 0 : lo;
              max[b] = hi === -Infinity ? 0 : hi;
            }
            mins.push(min);
            maxs.push(max);
          } else {
            const p = peaksFor(ch, from, to, buckets);
            mins.push(p.min);
            maxs.push(p.max);
          }
        }
        const cache: PeakCache = { from, to, buckets, mins, maxs };
        st.peakCache = cache;
        return cache;
      };

      const drawMarker = (
        g: CanvasRenderingContext2D,
        x: number,
        color: string,
        h: number,
        w: number,
        label: string,
        isActive: boolean
      ) => {
        const lx = Math.max(1, Math.min(x, w - 1));
        g.strokeStyle = color;
        g.lineWidth = isActive ? 2 : 1.5;
        g.beginPath();
        g.moveTo(lx, 0);
        g.lineTo(lx, h);
        g.stroke();

        // Top handle flag
        const hx = Math.max(7, Math.min(lx, w - 7));
        g.fillStyle = color;
        g.beginPath();
        g.moveTo(hx - 6, 0);
        g.lineTo(hx + 6, 0);
        g.lineTo(hx, 11);
        g.closePath();
        g.fill();

        if (isActive) {
          g.font = '600 12px "DM Mono", ui-monospace, monospace';
          const tw = g.measureText(label).width;
          const pillX = Math.max(4, Math.min(hx + 8, w - tw - 14));
          g.fillStyle = resolvePalette().pillBg;
          g.fillRect(pillX, 3, tw + 10, 18);
          g.strokeStyle = color;
          g.lineWidth = 1;
          g.strokeRect(pillX, 3, tw + 10, 18);
          g.fillStyle = color;
          g.fillText(label, pillX + 5, 16);
        }
        g.lineWidth = 1;
      };

      const renderRuler = (
        g: CanvasRenderingContext2D,
        w: number,
        wh: number,
        COLORS: Palette
      ) => {
        g.fillStyle = COLORS.rulerBg;
        g.fillRect(0, wh, w, RULER_H);

        const pxPerSec = (w * st.sampleRate) / (st.viewEnd - st.viewStart);
        let step = TICK_STEPS[TICK_STEPS.length - 1];
        for (const s of TICK_STEPS) {
          if (s * pxPerSec >= TICK_MIN_PX) {
            step = s;
            break;
          }
        }
        const t0 = Math.max(0, st.viewStart / st.sampleRate);
        const t1 = Math.min(
          st.length / st.sampleRate,
          st.viewEnd / st.sampleRate
        );

        g.strokeStyle = COLORS.grid;
        g.beginPath();
        g.moveTo(0, wh + 0.5);
        g.lineTo(w, wh + 0.5);
        const minor = step / 5;
        if (minor * pxPerSec >= 9) {
          for (
            let t = Math.ceil(t0 / minor) * minor;
            t <= t1 + 1e-9;
            t += minor
          ) {
            const x = Math.round(sampleToPx(t * st.sampleRate)) + 0.5;
            g.moveTo(x, wh);
            g.lineTo(x, wh + 4);
          }
        }
        g.stroke();

        g.beginPath();
        const labels: Array<[number, number]> = [];
        for (let t = Math.ceil(t0 / step) * step; t <= t1 + 1e-9; t += step) {
          const x = Math.round(sampleToPx(t * st.sampleRate)) + 0.5;
          g.moveTo(x, wh);
          g.lineTo(x, wh + 7);
          labels.push([x, t]);
        }
        g.stroke();

        g.fillStyle = COLORS.legend;
        g.font = '12px "DM Mono", ui-monospace, monospace';
        for (const [x, t] of labels) {
          const text = fmtTick(t, step);
          const tx = Math.min(x + 4, w - g.measureText(text).width - 3);
          g.fillText(text, Math.max(3, tx), wh + 17);
        }
      };

      const render = () => {
        const dpr = window.devicePixelRatio || 1;
        const w = width();
        const h = height();
        if (
          cv.width !== Math.round(w * dpr) ||
          cv.height !== Math.round(h * dpr)
        ) {
          cv.width = Math.round(w * dpr);
          cv.height = Math.round(h * dpr);
        }
        const g = cv.getContext("2d");
        if (!g) {
          return;
        }
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        if (st.length === 0) {
          return;
        }
        const COLORS = resolvePalette();
        const wh = Math.max(10, h - RULER_H);

        // Waveform — mono full height, stereo+ stacked in two halves
        const peaks = visiblePeaks();
        const nCh = peaks.mins.length;
        const rowH = wh / Math.max(1, nCh);
        for (let ci = 0; ci < nCh; ci++) {
          const midY = rowH * ci + rowH / 2;
          const amp = rowH / 2 - 4;
          const mins = peaks.mins[ci];
          const maxs = peaks.maxs[ci];

          // Subtle center zero-line
          g.strokeStyle = COLORS.grid;
          g.beginPath();
          g.moveTo(0, midY);
          g.lineTo(w, midY);
          g.stroke();

          // Channel divider for stereo
          if (ci > 0) {
            g.strokeStyle = COLORS.grid;
            g.beginPath();
            g.moveTo(0, rowH * ci);
            g.lineTo(w, rowH * ci);
            g.stroke();
          }

          // Over full scale (gain past 0 dBFS) draws flat at the lane edge,
          // as the file will clip, with the clipped columns marked.
          g.strokeStyle = COLORS.wave;
          g.beginPath();
          for (let x = 0; x < peaks.buckets; x++) {
            const y0 = midY - Math.min(1, maxs[x]) * amp;
            const y1 = midY - Math.max(-1, mins[x]) * amp;
            g.moveTo(x + 0.5, y0);
            g.lineTo(x + 0.5, Math.max(y0 + 0.5, y1));
          }
          g.stroke();

          g.fillStyle = COLORS.clip;
          for (let x = 0; x < peaks.buckets; x++) {
            if (maxs[x] > 1) {
              g.fillRect(x, midY - amp - 2, 1, 3);
            }
            if (mins[x] < -1) {
              g.fillRect(x, midY + amp - 1, 1, 3);
            }
          }
        }

        if (st.loop) {
          const sPx = sampleToPx(st.loop.start);
          const ePx = sampleToPx(st.loop.end);
          const fx0 = st.loop.fadeAtHead
            ? sPx
            : sampleToPx(st.loop.end - st.loop.fade);
          const fx1 = st.loop.fadeAtHead
            ? sampleToPx(st.loop.start + st.loop.fade)
            : ePx;

          // Dim outside the loop
          g.fillStyle = COLORS.outsideLoop;
          if (sPx > 0) {
            g.fillRect(0, 0, Math.min(w, sPx), wh);
          }
          if (ePx < w) {
            g.fillRect(Math.max(0, ePx), 0, Math.max(0, w - Math.max(0, ePx)), wh);
          }

          // Crossfade zone + diagonal envelope lines
          if (st.loop.fade > 0 && fx1 > fx0) {
            const cfx0 = Math.max(0, fx0);
            const cfx1 = Math.min(w, fx1);
            if (cfx1 > cfx0) {
              g.fillStyle = COLORS.fade;
              g.fillRect(cfx0, 0, cfx1 - cfx0, wh);

              // Draw subtle X crossfade envelope slopes
              g.save();
              g.strokeStyle = COLORS.fadeLabel;
              g.globalAlpha = 0.45;
              g.setLineDash([3, 3]);
              g.beginPath();
              g.moveTo(fx0, 0);
              g.lineTo(fx1, wh);
              g.moveTo(fx0, wh);
              g.lineTo(fx1, 0);
              g.stroke();
              g.restore();

              if (cfx1 - cfx0 > 72) {
                g.fillStyle = COLORS.fadeLabel;
                g.font = '500 12px "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif';
                g.fillText("Crossfade", Math.max(6, fx0 + 6), wh - 8);
              }
            }
          }

          // Optional boundary Fade-In and Fade-Out visualization (Trim & Gain mode)
          if (st.loop.fadeInSamples && st.loop.fadeInSamples > 0) {
            const fiEndPx = Math.min(
              ePx,
              sampleToPx(st.loop.start + st.loop.fadeInSamples)
            );
            if (fiEndPx > sPx + 2) {
              g.save();
              g.fillStyle = COLORS.fade;
              g.fillRect(
                Math.max(0, sPx),
                0,
                Math.min(w, fiEndPx) - Math.max(0, sPx),
                wh
              );
              g.strokeStyle = COLORS.fadeLabel;
              g.globalAlpha = 0.65;
              g.beginPath();
              g.moveTo(sPx, wh);
              g.lineTo(fiEndPx, 0);
              g.stroke();
              g.restore();
            }
          }

          if (st.loop.fadeOutSamples && st.loop.fadeOutSamples > 0) {
            const foStartPx = Math.max(
              sPx,
              sampleToPx(st.loop.end - st.loop.fadeOutSamples)
            );
            if (ePx > foStartPx + 2) {
              g.save();
              g.fillStyle = COLORS.fade;
              g.fillRect(
                Math.max(0, foStartPx),
                0,
                Math.min(w, ePx) - Math.max(0, foStartPx),
                wh
              );
              g.strokeStyle = COLORS.fadeLabel;
              g.globalAlpha = 0.65;
              g.beginPath();
              g.moveTo(foStartPx, 0);
              g.lineTo(ePx, wh);
              g.stroke();
              g.restore();
            }
          }

          drawMarker(
            g,
            sPx,
            COLORS.start,
            wh,
            w,
            st.loop.startLabel || "S",
            st.activeMarker === "start"
          );
          drawMarker(
            g,
            ePx,
            COLORS.end,
            wh,
            w,
            st.loop.endLabel || "E",
            st.activeMarker === "end"
          );
        }

        // Hover hairline
        if (st.hoverSample !== null && !st.dragging && !st.panning) {
          const hx = sampleToPx(st.hoverSample);
          if (hx >= 0 && hx <= w) {
            g.strokeStyle = COLORS.hover;
            g.beginPath();
            g.moveTo(hx, 0);
            g.lineTo(hx, wh);
            g.stroke();
          }
        }

        // Playhead
        if (st.playhead !== null) {
          const x = sampleToPx(st.playhead);
          if (x >= 0 && x <= w) {
            g.strokeStyle = COLORS.playhead;
            g.lineWidth = 1.5;
            g.beginPath();
            g.moveTo(x, 0);
            g.lineTo(x, h);
            g.stroke();
            g.lineWidth = 1;
          }
        }

        renderRuler(g, w, wh, COLORS);
      };

      renderRef.current = render;

      const markerAt = (px: number): "start" | "end" | null => {
        if (!st.loop) {
          return null;
        }
        const sPx = sampleToPx(st.loop.start);
        const ePx = sampleToPx(st.loop.end);
        const ds = Math.abs(px - sPx);
        const de = Math.abs(px - ePx);
        if (ds <= MARKER_HIT_PX && ds <= de) {
          return "start";
        }
        if (de <= MARKER_HIT_PX) {
          return "end";
        }
        return null;
      };

      const onPointerDown = (e: PointerEvent) => {
        if (st.length === 0) {
          return;
        }
        try {
          cv.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        const hit = markerAt(e.offsetX);
        if (hit) {
          st.dragging = hit;
          st.activeMarker = hit;
          callbacksRef.current.onSelectMarker?.(hit);
          render();
        } else {
          st.panning = true;
          st.lastX = e.offsetX;
          st.downX = e.offsetX;
        }
      };

      const onPointerMove = (e: PointerEvent) => {
        const s = pxToSample(e.offsetX);
        st.hoverSample = s;
        if (st.dragging && st.loop) {
          cv.style.cursor = "ew-resize";
          const samp = Math.round(s);
          let { start, end } = st.loop;
          if (st.dragging === "start") {
            start = Math.max(0, Math.min(samp, end - 2));
          } else {
            end = Math.max(start + 2, Math.min(samp, st.length));
          }
          st.loop = { ...st.loop, start, end };
          callbacksRef.current.onLoopChange(start, end);
          render();
        } else if (st.panning) {
          const dx = e.offsetX - st.lastX;
          st.lastX = e.offsetX;
          const perPx = (st.viewEnd - st.viewStart) / width();
          st.viewStart -= dx * perPx;
          st.viewEnd -= dx * perPx;
          clampView();
          cv.style.cursor = "grabbing";
          render();
        } else {
          if (markerAt(e.offsetX)) {
            cv.style.cursor = "ew-resize";
          } else {
            cv.style.cursor = "crosshair";
          }
          render();
        }
      };

      const endDrag = () => {
        st.dragging = null;
        st.panning = false;
      };

      const onPointerUp = (e: PointerEvent) => {
        if (st.panning && Math.abs(e.offsetX - st.downX) < 4) {
          callbacksRef.current.onSeek(pxToSample(st.downX));
        }
        endDrag();
        render();
      };

      const onPointerLeave = () => {
        st.hoverSample = null;
        render();
      };

      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        if (st.length === 0) {
          return;
        }
        if (e.shiftKey) {
          const perPx = (st.viewEnd - st.viewStart) / width();
          const d = (e.deltaY + e.deltaX) * perPx;
          st.viewStart += d;
          st.viewEnd += d;
          clampView();
        } else {
          const anchor = pxToSample(e.offsetX);
          const factor = Math.exp(e.deltaY * 0.0015);
          const w0 = st.viewEnd - st.viewStart;
          const w1 = Math.max(
            MIN_VIEW_SAMPLES,
            Math.min(w0 * factor, st.length + 2 * st.pad)
          );
          const frac = (anchor - st.viewStart) / w0;
          st.viewStart = anchor - frac * w1;
          st.viewEnd = st.viewStart + w1;
          clampView();
        }
        render();
      };

      const onDblClick = () => {
        st.viewStart = -st.pad;
        st.viewEnd = st.length + st.pad;
        render();
      };

      cv.addEventListener("pointerdown", onPointerDown);
      cv.addEventListener("pointermove", onPointerMove);
      cv.addEventListener("pointerup", onPointerUp);
      cv.addEventListener("pointercancel", endDrag);
      cv.addEventListener("pointerleave", onPointerLeave);
      cv.addEventListener("wheel", onWheel, { passive: false });
      cv.addEventListener("dblclick", onDblClick);

      const ro = new ResizeObserver(() => render());
      ro.observe(cv);

      return () => {
        cv.removeEventListener("pointerdown", onPointerDown);
        cv.removeEventListener("pointermove", onPointerMove);
        cv.removeEventListener("pointerup", onPointerUp);
        cv.removeEventListener("pointercancel", endDrag);
        cv.removeEventListener("pointerleave", onPointerLeave);
        cv.removeEventListener("wheel", onWheel);
        cv.removeEventListener("dblclick", onDblClick);
        ro.disconnect();
      };
    }, []);

    // Update audio channels when source or processed channels change
    const prevLengthRef = useRef<number>(0);
    useEffect(() => {
      const st = stateRef.current;
      const chs = channels || [];
      const newLen = chs[0]?.length ?? 0;
      const isNewFile = newLen !== prevLengthRef.current || st.sampleRate !== sampleRate;
      prevLengthRef.current = newLen;

      st.channels = chs;
      st.sampleRate = sampleRate;
      st.length = newLen;
      st.pad = newLen * 0.02;
      if (isNewFile) {
        st.viewStart = -st.pad;
        st.viewEnd = newLen + st.pad;
        st.playhead = null;
      }
      st.overview = null;
      st.peakCache = null;

      if (newLen > 0) {
        const mins: Float32Array[] = [];
        const maxs: Float32Array[] = [];
        for (const ch of chs.slice(0, 2)) {
          const p = peaksFor(ch, 0, newLen, OVERVIEW_BUCKETS);
          mins.push(p.min);
          maxs.push(p.max);
        }
        st.overview = { mins, maxs };
      }
      renderRef.current();
    }, [channels, sampleRate]);

    useEffect(() => {
      const st = stateRef.current;
      st.loop = loop;
      st.activeMarker = activeMarker;
      renderRef.current();
    }, [loop, activeMarker]);

    useImperativeHandle(
      ref,
      () => ({
        resetView: () => {
          const st = stateRef.current;
          st.viewStart = -st.pad;
          st.viewEnd = st.length + st.pad;
          renderRef.current();
        },
        zoomToLoop: () => {
          const st = stateRef.current;
          if (!st.loop || st.length === 0) {
            return;
          }
          const span = Math.max(MIN_VIEW_SAMPLES, st.loop.end - st.loop.start);
          const margin = span * 0.08;
          st.viewStart = Math.max(-st.pad, st.loop.start - margin);
          st.viewEnd = Math.min(st.length + st.pad, st.loop.end + margin);
          renderRef.current();
        },
        zoomToSeam: () => {
          const st = stateRef.current;
          if (!st.loop || st.length === 0) {
            return;
          }
          const windowSamples = Math.max(
            MIN_VIEW_SAMPLES,
            Math.max(st.loop.fade * 3, Math.round(st.sampleRate * 0.4))
          );
          const center = st.loop.fadeAtHead ? st.loop.start : st.loop.end;
          st.viewStart = Math.max(-st.pad, center - windowSamples);
          st.viewEnd = Math.min(st.length + st.pad, center + windowSamples);
          renderRef.current();
        },
        zoomByFactor: (factor: number) => {
          const st = stateRef.current;
          if (st.length === 0) {
            return;
          }
          const mid = (st.viewStart + st.viewEnd) / 2;
          const w0 = st.viewEnd - st.viewStart;
          const w1 = Math.max(
            MIN_VIEW_SAMPLES,
            Math.min(w0 * factor, st.length + 2 * st.pad)
          );
          st.viewStart = Math.max(-st.pad, mid - w1 / 2);
          st.viewEnd = Math.min(st.length + st.pad, st.viewStart + w1);
          renderRef.current();
        },
        setPlayhead: (sample: number | null) => {
          const st = stateRef.current;
          if (st.playhead !== sample) {
            st.playhead = sample;
            renderRef.current();
          }
        },
      }),
      []
    );

    return (
      <canvas
        ref={canvasRef}
        className="sfx-editor-wave-canvas"
        role="img"
        aria-label="Audio editor waveform. Click to seek, scroll to zoom, drag to pan, drag green S and red E markers to adjust loop points."
      />
    );
  }
);
EditorWaveform.displayName = "EditorWaveform";
