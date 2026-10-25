import React, { useEffect, useRef } from "react";
import { EqSpec, evaluateEqResponseDb } from "./audio/dspChain";

interface SeamScopeProps {
  bakedChannels: Float32Array[] | null;
  sampleRate: number;
  fadeSamples: number;
}

function readTokenColor(varName: string, fallback: string): string {
  const probe = document.createElement("div");
  document.body.appendChild(probe);
  probe.style.color = `var(${varName}, ${fallback})`;
  const c = getComputedStyle(probe).color || fallback;
  probe.remove();
  return c;
}

/**
 * Real-time oscilloscope across the baked loop wrap boundary:
 * Left half shows the last `N` samples (`out[len-N .. len-1]`),
 * Right half shows the first `N` samples (`out[0 .. N-1]`),
 * with the center hairline marking the exact loop wrap point (`E -> S`).
 */
export const SeamScope: React.FC<SeamScopeProps> = ({
  bakedChannels,
  sampleRate,
  fadeSamples,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) {
      return;
    }
    const g = cv.getContext("2d");
    if (!g) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 260;
    const h = cv.clientHeight || 84;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const gridColor = readTokenColor(
      "--border-subtle",
      "rgba(255, 255, 255, 0.1)"
    );
    const tailColor = readTokenColor("--danger-400", "#eb6565");
    const headColor = readTokenColor("--success-500", "#45c486");
    const seamColor = readTokenColor("--accent-1-400", "#e6b85c");

    const midY = h / 2;
    const midX = w / 2;

    // Zero line and center wrap hairline
    g.strokeStyle = gridColor;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, midY);
    g.lineTo(w, midY);
    g.stroke();

    g.save();
    g.strokeStyle = seamColor;
    g.globalAlpha = 0.65;
    g.setLineDash([2, 2]);
    g.beginPath();
    g.moveTo(midX, 0);
    g.lineTo(midX, h);
    g.stroke();
    g.restore();

    const ch = bakedChannels?.[0];
    if (!ch || ch.length < 8) {
      return;
    }

    // Show ~25 ms before and ~25 ms after the wrap seam
    const halfSpan = Math.min(
      Math.floor(ch.length / 2),
      Math.max(64, Math.round(sampleRate * 0.025))
    );
    let peak = 0.05;
    for (let i = 0; i < halfSpan; i++) {
      const a = Math.abs(ch[ch.length - halfSpan + i]);
      const b = Math.abs(ch[i]);
      if (a > peak) {
        peak = a;
      }
      if (b > peak) {
        peak = b;
      }
    }
    const amp = (h / 2 - 6) / peak;

    // Left half: loop tail approaching the wrap
    g.strokeStyle = tailColor;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let px = 0; px <= midX; px++) {
      const t = px / Math.max(1, midX);
      const idx = Math.min(
        ch.length - 1,
        ch.length - halfSpan + Math.floor(t * (halfSpan - 1))
      );
      const y = midY - ch[idx] * amp;
      if (px === 0) {
        g.moveTo(px, y);
      } else {
        g.lineTo(px, y);
      }
    }
    g.stroke();

    // Right half: loop head leaving the wrap
    g.strokeStyle = headColor;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let px = midX; px <= w; px++) {
      const t = (px - midX) / Math.max(1, w - midX);
      const idx = Math.min(
        ch.length - 1,
        Math.floor(t * (halfSpan - 1))
      );
      const y = midY - ch[idx] * amp;
      if (px === midX) {
        g.moveTo(px, y);
      } else {
        g.lineTo(px, y);
      }
    }
    g.stroke();

    // Labels
    g.font = '500 9px "DM Mono", ui-monospace, monospace';
    g.fillStyle = tailColor;
    g.fillText("TAIL →", 6, 13);
    g.fillStyle = headColor;
    g.fillText("→ HEAD", w - 44, 13);
    if (fadeSamples > 0) {
      g.fillStyle = seamColor;
      g.fillText("SEAM", midX + 4, h - 6);
    }
  }, [bakedChannels, sampleRate, fadeSamples]);

  return (
    <canvas
      ref={canvasRef}
      className="sfx-seam-scope-canvas"
      aria-label="Loop seam phase and continuity oscilloscope"
    />
  );
};

interface EqResponseGraphProps {
  spec: EqSpec;
  sampleRate: number;
}

export const EqResponseGraph: React.FC<EqResponseGraphProps> = ({
  spec,
  sampleRate,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) {
      return;
    }
    const g = cv.getContext("2d");
    if (!g) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 260;
    const h = cv.clientHeight || 88;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const gridColor = readTokenColor(
      "--border-subtle",
      "rgba(255, 255, 255, 0.1)"
    );
    const curveColor = readTokenColor("--primary-400", "#7a86f5");
    const fillColor = readTokenColor(
      "--primary-muted-bg",
      "rgba(122, 134, 245, 0.18)"
    );
    const textColor = readTokenColor(
      "--text-tertiary",
      "rgba(200, 210, 225, 0.55)"
    );

    const midY = h / 2;
    const maxDb = 18;

    // 0 dB line & +/- 9 dB guide lines
    g.strokeStyle = gridColor;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, midY);
    g.lineTo(w, midY);
    g.moveTo(0, h * 0.25);
    g.lineTo(w, h * 0.25);
    g.moveTo(0, h * 0.75);
    g.lineTo(w, h * 0.75);
    g.stroke();

    const minLog = Math.log10(20);
    const maxLog = Math.log10(20000);

    const freqToX = (hz: number) =>
      ((Math.log10(hz) - minLog) / (maxLog - minLog)) * w;
    const xToFreq = (x: number) =>
      Math.pow(10, minLog + (x / Math.max(1, w)) * (maxLog - minLog));

    // Frequency grid ticks
    g.font = '9px "DM Mono", ui-monospace, monospace';
    g.fillStyle = textColor;
    for (const [hz, lbl] of [
      [100, "100"],
      [1000, "1k"],
      [10000, "10k"],
    ] as const) {
      const fx = freqToX(hz);
      g.fillText(lbl, fx - 8, h - 4);
    }

    // Response curve fill + stroke
    g.beginPath();
    g.moveTo(0, midY);
    for (let x = 0; x <= w; x += 2) {
      const hz = xToFreq(x);
      const db = evaluateEqResponseDb(spec, hz, sampleRate);
      const clamped = Math.max(-maxDb, Math.min(maxDb, db));
      const y = midY - (clamped / maxDb) * (h / 2 - 8);
      g.lineTo(x, y);
    }
    g.lineTo(w, midY);
    g.closePath();
    g.fillStyle = fillColor;
    g.fill();

    g.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const hz = xToFreq(x);
      const db = evaluateEqResponseDb(spec, hz, sampleRate);
      const clamped = Math.max(-maxDb, Math.min(maxDb, db));
      const y = midY - (clamped / maxDb) * (h / 2 - 8);
      if (x === 0) {
        g.moveTo(x, y);
      } else {
        g.lineTo(x, y);
      }
    }
    g.strokeStyle = curveColor;
    g.lineWidth = 1.75;
    g.stroke();
  }, [spec, sampleRate]);

  return (
    <canvas
      ref={canvasRef}
      className="sfx-seam-scope-canvas"
      aria-label="EQ frequency response curve"
    />
  );
};

interface VariationWaveCardCanvasProps {
  peaks: Float32Array;
  pitchCurve: Float32Array;
  volumeCurve: Float32Array;
  isActive: boolean;
}

export const VariationWaveCardCanvas: React.FC<
  VariationWaveCardCanvasProps
> = ({ peaks, pitchCurve, volumeCurve, isActive }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) {
      return;
    }
    const g = cv.getContext("2d");
    if (!g) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 180;
    const h = cv.clientHeight || 42;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const waveColor = readTokenColor(
      isActive ? "--primary-400" : "--gray-500",
      isActive ? "#7a86f5" : "#6c7385"
    );
    const pitchColor = readTokenColor("--accent-1-400", "#e6b85c");
    const volColor = readTokenColor("--accent-2-400", "#58b5c9");

    const midY = h / 2;
    const bins = peaks.length;
    if (bins === 0) {
      return;
    }

    // Draw mirrored waveform bars
    const step = w / bins;
    const barW = Math.max(1.2, step - 1);
    g.fillStyle = waveColor;
    for (let i = 0; i < bins; i++) {
      const amp = Math.max(0.05, peaks[i]);
      const bh = amp * (h - 6);
      g.fillRect(i * step, midY - bh / 2, barW, bh);
    }

    // Draw Volume modulation spline
    if (volumeCurve.length > 1) {
      g.strokeStyle = volColor;
      g.lineWidth = 1.1;
      g.globalAlpha = 0.65;
      g.beginPath();
      for (let i = 0; i < volumeCurve.length; i++) {
        const x = (i / (volumeCurve.length - 1)) * w;
        const y = midY - volumeCurve[i] * (h * 0.38);
        if (i === 0) {
          g.moveTo(x, y);
        } else {
          g.lineTo(x, y);
        }
      }
      g.stroke();
    }

    // Draw Pitch modulation spline
    if (pitchCurve.length > 1) {
      g.strokeStyle = pitchColor;
      g.lineWidth = 1.4;
      g.globalAlpha = 0.9;
      g.beginPath();
      for (let i = 0; i < pitchCurve.length; i++) {
        const x = (i / (pitchCurve.length - 1)) * w;
        const y = midY - pitchCurve[i] * (h * 0.4);
        if (i === 0) {
          g.moveTo(x, y);
        } else {
          g.lineTo(x, y);
        }
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  }, [peaks, pitchCurve, volumeCurve, isActive]);

  return (
    <canvas
      ref={canvasRef}
      className="sfx-var-wave-canvas"
      aria-label="Variation waveform and modulation spline preview"
    />
  );
};
