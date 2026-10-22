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
    const width = canvas.clientWidth || 240;
    const height = canvas.clientHeight || 36;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const safeDur = Math.max(0.01, durationS);
    const markerStartRatio = Math.min(1, Math.max(0, bestOffsetS / safeDur));
    const markerEndRatio = Math.min(1, Math.max(markerStartRatio, bestEndS / safeDur));

    if (bestOffsetS > 0 || bestEndS < safeDur) {
      ctx.fillStyle = "rgba(245, 158, 11, 0.14)";
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
        const amp = Math.min(1, Math.max(0.04, peaks[i] || 0));
        const barH = amp * (height - 4);
        const x = i * barStep;

        if (playRatio >= 0 && ratio <= playRatio) {
          ctx.fillStyle = isPlaying ? "#f59e0b" : "#d97706";
        } else if (ratio >= markerStartRatio && ratio <= markerEndRatio) {
          ctx.fillStyle = "#a1a1aa";
        } else {
          ctx.fillStyle = "#52525b";
        }
        ctx.fillRect(x, midY - barH / 2, barWidth, barH);
      }
    }

    const markerX = markerStartRatio * width;
    ctx.fillStyle = "#f59e0b";
    ctx.fillRect(markerX, 0, 2, height);

    if (currentTimeS !== null) {
      const playX = Math.min(width - 1, Math.max(0, (currentTimeS / safeDur) * width));
      ctx.fillStyle = "#38bdf8";
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
      className="h-9 w-56 cursor-pointer rounded bg-zinc-900/80 transition hover:bg-zinc-900"
    />
  );
};
