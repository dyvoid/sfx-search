import React, { useEffect, useRef, useState } from "react";
import { fetchPeaks } from "../api";

interface MiniWaveformProps {
  fileId: string;
  durationS: number;
  bestOffsetS: number;
  bestEndS: number;
  currentTimeS: number | null;
  isPlaying: boolean;
  onSeek: (timeS: number) => void;
}

const peaksCache = new Map<string, number[]>();

function readTokenColor(varName: string, fallback: string): string {
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return val || fallback;
}

function sampleInterpolatedPeaks(
  peaks: number[],
  count: number
): Float32Array {
  const out = new Float32Array(count);
  const n = peaks.length;
  if (n === 0 || count === 0) {
    return out;
  }

  let maxPeak = 0;
  for (let i = 0; i < n; i++) {
    if (peaks[i] > maxPeak) {
      maxPeak = peaks[i];
    }
  }
  const normScale = maxPeak > 0.001 ? 1 / maxPeak : 1;

  for (let i = 0; i < count; i++) {
    const pos = (i / Math.max(1, count - 1)) * (n - 1);
    const idx0 = Math.floor(pos);
    const idx1 = Math.min(n - 1, idx0 + 1);
    const frac = pos - idx0;
    const raw = peaks[idx0] * (1 - frac) + peaks[idx1] * frac;
    const normalized = Math.min(1, raw * normScale);
    // Gentle perceptual curve so quiet details read without turning silence into dashed blocks
    out[i] = Math.pow(normalized, 0.72);
  }
  return out;
}

export const MiniWaveform: React.FC<MiniWaveformProps> = ({
  fileId,
  durationS,
  bestOffsetS,
  bestEndS,
  currentTimeS,
  isPlaying,
  onSeek,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [peaks, setPeaks] = useState<number[]>(() => peaksCache.get(fileId) || []);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [canvasWidth, setCanvasWidth] = useState<number>(320);

  useEffect(() => {
    let active = true;
    const cached = peaksCache.get(fileId);
    if (cached) {
      setPeaks(cached);
      return;
    }
    fetchPeaks(fileId).then((p) => {
      if (active && p.length > 0) {
        peaksCache.set(fileId, p);
        setPeaks(p);
      }
    });
    return () => {
      active = false;
    };
  }, [fileId]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width);
        if (w > 0) {
          setCanvasWidth(w);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = canvasWidth || canvas.clientWidth || 320;
    const height = canvas.clientHeight || 34;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const primaryColor = readTokenColor("--primary-400", "oklch(62% 0.14 275)");
    const accent1Color = readTokenColor("--accent-1-400", "oklch(78% 0.12 55)");
    const accent2Color = readTokenColor("--accent-2-400", "oklch(78% 0.08 190)");
    const waveIdle = readTokenColor("--gray-500", "oklch(52% 0.015 260)");
    const waveWindow = readTokenColor("--gray-200", "oklch(85% 0.009 260)");
    const centerLine = readTokenColor(
      "--border-subtle",
      "oklch(100% 0 0 / 0.08)"
    );
    const hoverLine = readTokenColor("--gray-300", "oklch(74% 0.011 260)");

    const safeDur = Math.max(0.01, durationS);
    const hasSubWindow =
      bestOffsetS > 0.05 || (bestEndS > 0 && bestEndS < safeDur - 0.15);
    const markerStartRatio = Math.min(1, Math.max(0, bestOffsetS / safeDur));
    const markerEndRatio = Math.min(
      1,
      Math.max(markerStartRatio, bestEndS / safeDur)
    );
    const midY = height / 2;

    // 1. Subtle continuous baseline
    ctx.fillStyle = centerLine;
    ctx.fillRect(0, midY - 0.5, width, 1);

    // 2. Subtle best-match window indicator (only when file is longer than a single chunk)
    if (hasSubWindow) {
      const rx = markerStartRatio * width;
      const rw = Math.max(3, (markerEndRatio - markerStartRatio) * width);
      ctx.save();
      ctx.globalAlpha = 0.09;
      ctx.fillStyle = accent1Color;
      ctx.fillRect(rx, 0, rw, height);
      ctx.globalAlpha = 0.55;
      ctx.fillRect(rx, 0, rw, 1.5);
      ctx.restore();
    }

    // 3. High-density normalized waveform bars (2px pitch: 1.5px bar, 0.5px gap)
    if (peaks.length > 0) {
      const pitch = 2.5;
      const barW = 1.5;
      const numBars = Math.max(32, Math.floor(width / pitch));
      const sampled = sampleInterpolatedPeaks(peaks, numBars);
      const maxHalfH = (height - 6) / 2;
      const playRatio =
        currentTimeS !== null
          ? Math.min(1, Math.max(0, currentTimeS / safeDur))
          : -1;

      for (let i = 0; i < numBars; i++) {
        const ratio = i / numBars;
        const val = sampled[i];
        const x = i * pitch;

        // Silence stays a tiny 0.75px tick on the center line instead of a dashed block
        const halfH = val < 0.025 ? 0.5 : Math.max(1.2, val * maxHalfH);

        if (playRatio >= 0 && ratio <= playRatio) {
          ctx.fillStyle = isPlaying ? primaryColor : accent1Color;
        } else if (
          hasSubWindow &&
          ratio >= markerStartRatio &&
          ratio <= markerEndRatio
        ) {
          ctx.fillStyle = waveWindow;
        } else {
          ctx.fillStyle = waveIdle;
        }

        ctx.fillRect(x, midY - halfH, barW, halfH * 2);
      }
    }

    // 4. Best-offset cue line (only when offset > 0)
    if (bestOffsetS > 0.05) {
      const mx = Math.min(width - 1.5, Math.max(0, markerStartRatio * width));
      ctx.fillStyle = accent1Color;
      ctx.fillRect(mx, 0, 1.5, height);
    }

    // 5. Hover scrub hairline
    if (hoverRatio !== null) {
      const hx = Math.min(width - 1, Math.max(0, hoverRatio * width));
      ctx.fillStyle = hoverLine;
      ctx.fillRect(hx, 0, 1, height);
    }

    // 6. Active playhead cursor
    if (currentTimeS !== null) {
      const playX = Math.min(
        width - 1.5,
        Math.max(0, (currentTimeS / safeDur) * width)
      );
      ctx.fillStyle = accent2Color;
      ctx.fillRect(playX, 0, 1.5, height);
    }
  }, [
    peaks,
    durationS,
    bestOffsetS,
    bestEndS,
    currentTimeS,
    isPlaying,
    hoverRatio,
    canvasWidth,
  ]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(ratio * Math.max(0.01, durationS));
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHoverRatio(ratio);
  };

  const safeDur = Math.max(0.01, durationS);
  const hoverTimeS = hoverRatio !== null ? hoverRatio * safeDur : null;

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        width: "100%",
        height: 34,
        overflow: "hidden",
      }}
    >
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverRatio(null)}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          cursor: "pointer",
        }}
      />
      {(bestOffsetS > 0.05 || hoverTimeS !== null) && (
        <span
          className="ds-tnum"
          style={{
            position: "absolute",
            right: 4,
            bottom: 2,
            pointerEvents: "none",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-2xs)",
            color:
              hoverTimeS !== null
                ? "var(--text-primary)"
                : "var(--accent-1-400)",
            background: "oklch(from var(--surface-app) l c h / 0.85)",
            padding: "0 4px",
            borderRadius: "var(--radius-xs)",
          }}
        >
          {hoverTimeS !== null
            ? `${hoverTimeS.toFixed(1)}s`
            : `@${bestOffsetS.toFixed(1)}s`}
        </span>
      )}
    </div>
  );
};
