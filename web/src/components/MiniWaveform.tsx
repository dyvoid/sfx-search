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
    const width = canvas.clientWidth || 220;
    const height = canvas.clientHeight || 32;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const primaryColor = readTokenColor("--primary", "oklch(58% 0.17 275)");
    const accent1Color = readTokenColor("--accent-1-500", "oklch(72% 0.15 55)");
    const accent1Muted = readTokenColor("--accent-1-muted-bg", "oklch(72% 0.15 55 / 0.18)");
    const accent2Color = readTokenColor("--accent-2-400", "oklch(78% 0.08 190)");
    const barDefault = readTokenColor("--gray-600", "oklch(42% 0.018 260)");
    const barWindow = readTokenColor("--gray-400", "oklch(63% 0.013 260)");

    const safeDur = Math.max(0.01, durationS);
    const markerStartRatio = Math.min(1, Math.max(0, bestOffsetS / safeDur));
    const markerEndRatio = Math.min(1, Math.max(markerStartRatio, bestEndS / safeDur));

    if (bestOffsetS > 0 || bestEndS < safeDur) {
      ctx.fillStyle = accent1Muted;
      const rx = markerStartRatio * width;
      const rw = Math.max(3, (markerEndRatio - markerStartRatio) * width);
      ctx.fillRect(rx, 0, rw, height);
    }

    const n = peaks.length;
    if (n > 0) {
      const barStep = width / n;
      const barWidth = Math.max(1, barStep - 1);
      const midY = height / 2;
      const playRatio =
        currentTimeS !== null ? Math.min(1, Math.max(0, currentTimeS / safeDur)) : -1;

      for (let i = 0; i < n; i++) {
        const ratio = i / n;
        const amp = Math.min(1, Math.max(0.05, peaks[i] || 0));
        const barH = amp * (height - 4);
        const x = i * barStep;

        if (playRatio >= 0 && ratio <= playRatio) {
          ctx.fillStyle = isPlaying ? primaryColor : accent1Color;
        } else if (ratio >= markerStartRatio && ratio <= markerEndRatio) {
          ctx.fillStyle = barWindow;
        } else {
          ctx.fillStyle = barDefault;
        }
        ctx.fillRect(x, midY - barH / 2, barWidth, barH);
      }
    }

    const markerX = markerStartRatio * width;
    ctx.fillStyle = accent1Color;
    ctx.fillRect(markerX, 0, 2, height);

    if (currentTimeS !== null) {
      const playX = Math.min(width - 1, Math.max(0, (currentTimeS / safeDur) * width));
      ctx.fillStyle = accent2Color;
      ctx.fillRect(playX, 0, 2, height);
    }
  }, [peaks, durationS, bestOffsetS, bestEndS, currentTimeS, isPlaying]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(ratio * Math.max(0.01, durationS));
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      title={`Best match at ${bestOffsetS.toFixed(1)}s — click to seek`}
      style={{
        width: 220,
        height: 32,
        borderRadius: "var(--radius-sm)",
        background: "var(--surface-sunken)",
        border: "var(--border-width) solid var(--border-subtle)",
        cursor: "pointer",
        flexShrink: 0,
      }}
    />
  );
};
