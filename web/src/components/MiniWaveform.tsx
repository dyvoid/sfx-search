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

function buildSmoothEnvelope(
  peaks: number[],
  numSamples: number
): Float32Array {
  const raw = new Float32Array(numSamples);
  const n = peaks.length;
  if (n === 0 || numSamples === 0) {
    return raw;
  }

  let maxPeak = 0;
  for (let i = 0; i < n; i++) {
    if (peaks[i] > maxPeak) {
      maxPeak = peaks[i];
    }
  }
  const normScale = maxPeak > 0.001 ? 1 / maxPeak : 1;

  for (let i = 0; i < numSamples; i++) {
    const pos = (i / Math.max(1, numSamples - 1)) * (n - 1);
    const idx0 = Math.floor(pos);
    const idx1 = Math.min(n - 1, idx0 + 1);
    const frac = pos - idx0;
    const v = (peaks[idx0] * (1 - frac) + peaks[idx1] * frac) * normScale;
    raw[i] = Math.pow(Math.min(1, Math.max(0, v)), 0.78);
  }

  // Light 3-tap Gaussian smoothing so wide waveforms look like a continuous studio envelope
  const smoothed = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const prev = raw[Math.max(0, i - 1)];
    const curr = raw[i];
    const next = raw[Math.min(numSamples - 1, i + 1)];
    smoothed[i] = 0.22 * prev + 0.56 * curr + 0.22 * next;
  }
  return smoothed;
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
  const [isVisible, setIsVisible] = useState<boolean>(() =>
    peaksCache.has(fileId)
  );
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [canvasWidth, setCanvasWidth] = useState<number>(320);

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
    const height = canvas.clientHeight || 36;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const primaryColor = readTokenColor("--primary-400", "oklch(62% 0.14 275)");
    const accent1Color = readTokenColor("--accent-1-400", "oklch(78% 0.12 55)");
    const accent2Color = readTokenColor("--accent-2-400", "oklch(78% 0.08 190)");
    const waveStrokeIdle = readTokenColor("--gray-400", "oklch(63% 0.013 260)");
    const waveFillIdle = readTokenColor("--gray-600", "oklch(42% 0.018 260)");
    const centerLine = readTokenColor(
      "--border-subtle",
      "oklch(100% 0 0 / 0.08)"
    );
    const hoverColor = readTokenColor("--gray-200", "oklch(85% 0.009 260)");

    const safeDur = Math.max(0.01, durationS);
    const windowLen = Math.max(0, bestEndS - bestOffsetS);
    // Only highlight a sub-window when the file is meaningfully longer than a single 10s window
    const hasSubWindow =
      safeDur > 12.5 &&
      (bestOffsetS > 0.5 || (windowLen > 0 && windowLen < safeDur * 0.82));
    const markerStartRatio = Math.min(1, Math.max(0, bestOffsetS / safeDur));
    const markerEndRatio = Math.min(
      1,
      Math.max(markerStartRatio, bestEndS / safeDur)
    );
    const midY = height / 2;

    // 1. Subtle zero-crossing axis line
    ctx.fillStyle = centerLine;
    ctx.fillRect(0, midY - 0.5, width, 1);

    // 2. Best-match sub-window region (only on genuinely long multi-window files)
    if (hasSubWindow) {
      const rx = markerStartRatio * width;
      const rw = Math.max(3, (markerEndRatio - markerStartRatio) * width);
      ctx.save();
      ctx.globalAlpha = 0.055;
      ctx.fillStyle = accent1Color;
      ctx.fillRect(rx, 3, rw, height - 6);
      ctx.globalAlpha = 0.45;
      ctx.fillRect(rx, height - 1.5, rw, 1.5);
      ctx.restore();
    }

    // 3. Continuous mirror-envelope waveform (Arturia Pigments / FabFilter style)
    if (peaks.length > 0) {
      const sampleCount = Math.max(80, Math.min(360, Math.floor(width / 1.5)));
      const env = buildSmoothEnvelope(peaks, sampleCount);
      const maxAmpH = (height - 6) / 2;

      const drawEnvelopePass = (
        fillStyle: string,
        strokeStyle: string,
        fillAlpha: number
      ) => {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(0, midY);
        for (let i = 0; i < sampleCount; i++) {
          const x = (i / (sampleCount - 1)) * width;
          const h = env[i] < 0.015 ? 0 : env[i] * maxAmpH;
          ctx.lineTo(x, midY - h);
        }
        for (let i = sampleCount - 1; i >= 0; i--) {
          const x = (i / (sampleCount - 1)) * width;
          const h = env[i] < 0.015 ? 0 : env[i] * maxAmpH;
          ctx.lineTo(x, midY + h);
        }
        ctx.closePath();
        ctx.globalAlpha = fillAlpha;
        ctx.fillStyle = fillStyle;
        ctx.fill();

        // Upper & lower crest strokes for crisp definition at large sizes
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = 1.15;
        ctx.lineJoin = "round";

        ctx.beginPath();
        for (let i = 0; i < sampleCount; i++) {
          const x = (i / (sampleCount - 1)) * width;
          const h = env[i] < 0.015 ? 0 : env[i] * maxAmpH;
          if (i === 0) {
            ctx.moveTo(x, midY - h);
          } else {
            ctx.lineTo(x, midY - h);
          }
        }
        ctx.stroke();

        ctx.beginPath();
        for (let i = 0; i < sampleCount; i++) {
          const x = (i / (sampleCount - 1)) * width;
          const h = env[i] < 0.015 ? 0 : env[i] * maxAmpH;
          if (i === 0) {
            ctx.moveTo(x, midY + h);
          } else {
            ctx.lineTo(x, midY + h);
          }
        }
        ctx.stroke();
        ctx.restore();
      };

      // Base unplayed waveform
      drawEnvelopePass(waveFillIdle, waveStrokeIdle, 0.22);

      // Highlighted best-window clip (only on long multi-window files)
      if (hasSubWindow) {
        const rx = markerStartRatio * width;
        const rw = Math.max(2, (markerEndRatio - markerStartRatio) * width);
        ctx.save();
        ctx.beginPath();
        ctx.rect(rx, 0, rw, height);
        ctx.clip();
        drawEnvelopePass(accent1Color, accent1Color, 0.22);
        ctx.restore();
      }

      // Played progress clip
      if (currentTimeS !== null) {
        const playRatio = Math.min(1, Math.max(0, currentTimeS / safeDur));
        const pw = playRatio * width;
        if (pw > 0.5) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, pw, height);
          ctx.clip();
          const activeColor = isPlaying ? primaryColor : accent1Color;
          drawEnvelopePass(activeColor, activeColor, 0.38);
          ctx.restore();
        }
      }
    }

    // 4. Best-offset cue line (only when offset > 0.5s on a long file)
    if (hasSubWindow && bestOffsetS > 0.5) {
      const mx = Math.min(width - 1, Math.max(0, markerStartRatio * width));
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = accent1Color;
      ctx.fillRect(mx, 3, 1, height - 6);
      ctx.restore();
    }

    // 5. Hover scrub hairline + center node
    if (hoverRatio !== null) {
      const hx = Math.min(width - 1, Math.max(0, hoverRatio * width));
      ctx.fillStyle = hoverColor;
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

  const isScrubbingRef = useRef<boolean>(false);

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
        height: 36,
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
