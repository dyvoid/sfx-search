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

export const MiniWaveform: React.FC<MiniWaveformProps> = ({
  fileId,
  durationS,
  bestOffsetS,
  bestEndS,
  currentTimeS,
  isPlaying,
  onSeek,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [peaks, setPeaks] = useState<number[]>(() => peaksCache.get(fileId) || []);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);

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
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 280;
    const height = canvas.clientHeight || 36;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const primaryColor = readTokenColor("--primary", "oklch(58% 0.17 275)");
    const accent1Color = readTokenColor("--accent-1-500", "oklch(72% 0.15 55)");
    const accent1Muted = readTokenColor(
      "--accent-1-muted-bg",
      "oklch(72% 0.15 55 / 0.18)"
    );
    const accent2Color = readTokenColor("--accent-2-400", "oklch(78% 0.08 190)");
    const barDefault = readTokenColor("--gray-600", "oklch(42% 0.018 260)");
    const barWindow = readTokenColor("--gray-300", "oklch(74% 0.011 260)");
    const borderSubtle = readTokenColor(
      "--border-subtle",
      "oklch(100% 0 0 / 0.10)"
    );
    const textSecondary = readTokenColor("--gray-200", "oklch(85% 0.009 260)");

    const safeDur = Math.max(0.01, durationS);
    const markerStartRatio = Math.min(1, Math.max(0, bestOffsetS / safeDur));
    const markerEndRatio = Math.min(
      1,
      Math.max(markerStartRatio, bestEndS / safeDur)
    );
    const midY = height / 2;

    // Zero-crossing center hairline
    ctx.fillStyle = borderSubtle;
    ctx.fillRect(0, Math.floor(midY), width, 1);

    // Best-matching 10s window bracket fill
    if (bestOffsetS > 0 || bestEndS < safeDur) {
      ctx.fillStyle = accent1Muted;
      const rx = markerStartRatio * width;
      const rw = Math.max(4, (markerEndRatio - markerStartRatio) * width);
      ctx.fillRect(rx, 0, rw, height);
    }

    // Symmetrical studio waveform bars
    const n = peaks.length;
    if (n > 0) {
      const targetBars = Math.min(n, Math.max(48, Math.floor(width / 3)));
      const stepIdx = n / targetBars;
      const barStep = width / targetBars;
      const barWidth = Math.max(1.2, barStep - 1.2);
      const playRatio =
        currentTimeS !== null
          ? Math.min(1, Math.max(0, currentTimeS / safeDur))
          : -1;

      for (let i = 0; i < targetBars; i++) {
        const srcIdx = Math.min(n - 1, Math.floor(i * stepIdx));
        const ratio = i / targetBars;
        const rawPeak = peaks[srcIdx] || 0;
        const amp = Math.min(1, Math.max(0.06, Math.pow(rawPeak, 0.85)));
        const halfH = (amp * (height - 6)) / 2;
        const x = i * barStep;

        if (playRatio >= 0 && ratio <= playRatio) {
          ctx.fillStyle = isPlaying ? primaryColor : accent1Color;
        } else if (ratio >= markerStartRatio && ratio <= markerEndRatio) {
          ctx.fillStyle = barWindow;
        } else {
          ctx.fillStyle = barDefault;
        }

        ctx.fillRect(x, midY - halfH, barWidth, halfH * 2);
      }
    }

    // Best-offset start marker + top cap
    const markerX = Math.min(width - 2, Math.max(0, markerStartRatio * width));
    ctx.fillStyle = accent1Color;
    ctx.fillRect(markerX, 0, 1.5, height);
    ctx.fillRect(markerX, 0, 5, 2);
    ctx.fillRect(markerX, height - 2, 5, 2);

    // Hover scrub hairline
    if (hoverRatio !== null) {
      const hx = Math.min(width - 1, Math.max(0, hoverRatio * width));
      ctx.fillStyle = textSecondary;
      ctx.fillRect(hx, 0, 1, height);
    }

    // Active playhead cursor
    if (currentTimeS !== null) {
      const playX = Math.min(
        width - 2,
        Math.max(0, (currentTimeS / safeDur) * width)
      );
      ctx.fillStyle = accent2Color;
      ctx.fillRect(playX, 0, 2, height);
    }
  }, [
    peaks,
    durationS,
    bestOffsetS,
    bestEndS,
    currentTimeS,
    isPlaying,
    hoverRatio,
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
      style={{
        position: "relative",
        width: "100%",
        height: 36,
        borderRadius: "var(--radius-sm)",
        background: "var(--surface-sunken)",
        border: "var(--border-width) solid var(--border-subtle)",
        boxShadow: "var(--inset-rail)",
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
      {(bestOffsetS > 0 || hoverTimeS !== null) && (
        <span
          className="ds-tnum"
          style={{
            position: "absolute",
            right: 6,
            bottom: 3,
            pointerEvents: "none",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-2xs)",
            color:
              hoverTimeS !== null
                ? "var(--text-primary)"
                : "var(--accent-1-400)",
            background: "oklch(from var(--surface-sunken) l c h / 0.82)",
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
