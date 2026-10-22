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
  height?: number;
  selectedChunkRange?: { startS: number; endS: number } | null;
}

const peaksCache = new Map<string, number[]>();

function readTokenColor(varName: string, fallback: string): string {
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return val || fallback;
}

function sampleBars(peaks: number[], barCount: number): Float32Array {
  const bars = new Float32Array(barCount);
  const n = peaks.length;
  if (n === 0 || barCount <= 0) {
    return bars;
  }

  let maxPeak = 0;
  for (let i = 0; i < n; i++) {
    if (peaks[i] > maxPeak) {
      maxPeak = peaks[i];
    }
  }
  const normScale = maxPeak > 0.001 ? 1 / maxPeak : 1;

  for (let i = 0; i < barCount; i++) {
    const pos = (i / Math.max(1, barCount - 1)) * (n - 1);
    const idx0 = Math.floor(pos);
    const idx1 = Math.min(n - 1, idx0 + 1);
    const frac = pos - idx0;
    const v = (peaks[idx0] * (1 - frac) + peaks[idx1] * frac) * normScale;
    bars[i] = Math.min(1, Math.max(0, v));
  }
  return bars;
}

export const MiniWaveform: React.FC<MiniWaveformProps> = ({
  fileId,
  durationS,
  bestOffsetS,
  bestEndS,
  currentTimeS,
  isPlaying,
  onSeek,
  height = 36,
  selectedChunkRange = null,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [peaks, setPeaks] = useState<number[]>(() => peaksCache.get(fileId) || []);
  const [isVisible, setIsVisible] = useState<boolean>(() =>
    peaksCache.has(fileId)
  );
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [canvasWidth, setCanvasWidth] = useState<number>(320);
  const isScrubbingRef = useRef<boolean>(false);

  useEffect(() => {
    if (peaksCache.has(fileId)) {
      setIsVisible(true);
      setPeaks(peaksCache.get(fileId) || []);
      return;
    }
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setIsVisible(true);
            io.disconnect();
            break;
          }
        }
      },
      { rootMargin: "280px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [fileId]);

  useEffect(() => {
    if (!isVisible) {
      return;
    }
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
  }, [fileId, isVisible]);

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
    const h = height;
    canvas.width = width * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, h);

    // Exact same token palette used across row and sidebar waveforms
    const waveColor = readTokenColor("--gray-500", "oklch(52% 0.015 260)");
    const progressColor = readTokenColor(
      "--primary-400",
      "oklch(62% 0.14 275)"
    );
    const cursorColor = readTokenColor("--accent-2-400", "oklch(78% 0.08 190)");
    const regionColor = readTokenColor(
      "--primary-muted-bg",
      "oklch(58% 0.14 275 / 0.16)"
    );
    const accent1Color = readTokenColor("--accent-1-400", "oklch(78% 0.12 55)");
    const hoverColor = readTokenColor("--gray-200", "oklch(85% 0.009 260)");

    const safeDur = Math.max(0.01, durationS);
    const activeRange = selectedChunkRange || {
      startS: bestOffsetS,
      endS: bestEndS,
    };
    const windowLen = Math.max(0, activeRange.endS - activeRange.startS);
    const hasSubWindow =
      safeDur > 12.5 &&
      (activeRange.startS > 0.5 || (windowLen > 0 && windowLen < safeDur * 0.85));
    const markerStartRatio = Math.min(
      1,
      Math.max(0, activeRange.startS / safeDur)
    );
    const markerEndRatio = Math.min(
      1,
      Math.max(markerStartRatio, activeRange.endS / safeDur)
    );
    const midY = h / 2;

    // 1. Optional sub-window region highlight on long files (> 12.5s)
    if (hasSubWindow) {
      const rx = markerStartRatio * width;
      const rw = Math.max(3, (markerEndRatio - markerStartRatio) * width);
      ctx.save();
      ctx.fillStyle = regionColor;
      ctx.fillRect(rx, 2, rw, h - 4);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = accent1Color;
      ctx.fillRect(rx, h - 1.5, rw, 1.5);
      ctx.restore();
    }

    // 2. Unified WaveSurfer-style crisp 2px bars with 1px gap
    const barWidth = 2;
    const barGap = 1;
    const step = barWidth + barGap;
    const barCount = Math.max(16, Math.floor(width / step));
    const bars = sampleBars(peaks, barCount);
    const maxBarHeight = h - 4;
    const playRatio =
      currentTimeS !== null
        ? Math.min(1, Math.max(0, currentTimeS / safeDur))
        : -1;

    for (let i = 0; i < barCount; i++) {
      const x = i * step;
      const barRatio = i / Math.max(1, barCount - 1);
      const amp = bars[i] || 0;
      const barH = amp < 0.015 ? 1.5 : Math.max(2, amp * maxBarHeight);
      const y = midY - barH / 2;

      if (playRatio >= 0 && barRatio <= playRatio) {
        ctx.fillStyle = progressColor;
      } else if (
        hasSubWindow &&
        barRatio >= markerStartRatio &&
        barRatio <= markerEndRatio
      ) {
        ctx.fillStyle = accent1Color;
      } else {
        ctx.fillStyle = waveColor;
      }

      ctx.fillRect(x, y, barWidth, barH);
    }

    // 3. Hover scrub hairline
    if (hoverRatio !== null) {
      const hx = Math.min(width - 1, Math.max(0, hoverRatio * width));
      ctx.fillStyle = hoverColor;
      ctx.fillRect(hx, 0, 1, h);
    }

    // 4. Active playhead cursor
    if (currentTimeS !== null) {
      const playX = Math.min(
        width - 1.5,
        Math.max(0, (currentTimeS / safeDur) * width)
      );
      ctx.fillStyle = isPlaying ? cursorColor : progressColor;
      ctx.fillRect(playX, 0, 1.5, h);
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
    height,
    selectedChunkRange,
  ]);

  const ratioFromClientX = (
    el: HTMLCanvasElement,
    clientX: number
  ): number => {
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    isScrubbingRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    const ratio = ratioFromClientX(e.currentTarget, e.clientX);
    setHoverRatio(ratio);
    onSeek(ratio * Math.max(0.01, durationS));
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ratio = ratioFromClientX(e.currentTarget, e.clientX);
    setHoverRatio(ratio);
    if (isScrubbingRef.current) {
      onSeek(ratio * Math.max(0.01, durationS));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isScrubbingRef.current) {
      isScrubbingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
  };

  const safeDur = Math.max(0.01, durationS);
  const hoverTimeS = hoverRatio !== null ? hoverRatio * safeDur : null;

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        width: "100%",
        height,
        overflow: "hidden",
      }}
    >
      <canvas
        ref={canvasRef}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => {
          isScrubbingRef.current = false;
          setHoverRatio(null);
        }}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          cursor: "pointer",
          touchAction: "pan-y",
        }}
      />
      {hoverTimeS !== null && hoverRatio !== null ? (
        <span
          className="ds-tnum"
          style={{
            position: "absolute",
            left: `clamp(4px, calc(${(hoverRatio * 100).toFixed(1)}% - 22px), calc(100% - 48px))`,
            top: 2,
            pointerEvents: "none",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-2xs)",
            color: "var(--text-primary)",
            background: "var(--surface-overlay)",
            border: "var(--border-width) solid var(--border-subtle)",
            padding: "0 5px",
            borderRadius: "var(--radius-xs)",
            lineHeight: 1.35,
          }}
        >
          {hoverTimeS.toFixed(2)}s
        </span>
      ) : safeDur > 12.5 && bestOffsetS > 0.5 ? (
        <span
          className="ds-tnum"
          style={{
            position: "absolute",
            right: 4,
            bottom: 2,
            pointerEvents: "none",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-2xs)",
            color: "var(--text-tertiary)",
            background: "oklch(from var(--surface-app) l c h / 0.8)",
            padding: "0 4px",
            borderRadius: "var(--radius-xs)",
          }}
        >
          @{bestOffsetS.toFixed(1)}s
        </span>
      ) : null}
    </div>
  );
};
