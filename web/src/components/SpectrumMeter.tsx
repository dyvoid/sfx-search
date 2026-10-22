import React, { useEffect, useRef } from "react";

interface SpectrumMeterProps {
  audioElement: HTMLAudioElement | null;
  isPlaying: boolean;
}

interface AudioGraph {
  ctx: AudioContext;
  analyser: AnalyserNode;
}

const graphMap = new WeakMap<HTMLAudioElement, AudioGraph>();

function readToken(varName: string, fallback: string): string {
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return val || fallback;
}

export const SpectrumMeter: React.FC<SpectrumMeterProps> = ({
  audioElement,
  isPlaying,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const peaksHoldRef = useRef<Float32Array>(new Float32Array(16));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = 92;
    const height = 24;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx2d.scale(dpr, dpr);

    const primaryColor = readToken("--primary-400", "oklch(62% 0.14 275)");
    const accent1Color = readToken("--accent-1-400", "oklch(78% 0.12 55)");
    const trackColor = readToken("--gray-700", "oklch(32% 0.022 260)");

    const bands = 16;
    const step = width / bands;
    const barW = step - 1.5;

    const drawIdle = () => {
      ctx2d.clearRect(0, 0, width, height);
      for (let i = 0; i < bands; i++) {
        const x = i * step;
        ctx2d.fillStyle = trackColor;
        ctx2d.fillRect(x, height - 2, barW, 2);
      }
    };

    if (!isPlaying || !audioElement) {
      drawIdle();
      return;
    }

    let graph = graphMap.get(audioElement);
    if (!graph) {
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const audioCtx = new AudioCtx();
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.76;
        const source = audioCtx.createMediaElementSource(audioElement);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        graph = { ctx: audioCtx, analyser };
        graphMap.set(audioElement, graph);
      } catch {
        drawIdle();
        return;
      }
    }

    if (graph.ctx.state === "suspended") {
      graph.ctx.resume().catch(() => {});
    }

    const freqData = new Uint8Array(graph.analyser.frequencyBinCount);
    const hold = peaksHoldRef.current;
    let rafId = 0;

    const renderFrame = () => {
      rafId = window.requestAnimationFrame(renderFrame);
      if (!graph || document.hidden) {
        return;
      }
      graph.analyser.getByteFrequencyData(freqData);
      ctx2d.clearRect(0, 0, width, height);

      for (let i = 0; i < bands; i++) {
        const binIdx = Math.min(freqData.length - 1, Math.floor((i * 22) / bands));
        const norm = freqData[binIdx] / 255;
        const barH = Math.max(2, norm * (height - 2));
        const x = i * step;

        if (barH >= hold[i]) {
          hold[i] = barH;
        } else {
          hold[i] = Math.max(2, hold[i] - 0.35);
        }

        ctx2d.fillStyle = norm > 0.78 ? accent1Color : primaryColor;
        ctx2d.fillRect(x, height - barH, barW, barH);

        if (hold[i] > 3) {
          ctx2d.fillStyle = accent1Color;
          ctx2d.fillRect(x, Math.max(0, height - hold[i] - 1.5), barW, 1.2);
        }
      }
    };

    rafId = window.requestAnimationFrame(renderFrame);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [audioElement, isPlaying]);

  return (
    <canvas
      ref={canvasRef}
      aria-label="Live audio spectrum analyzer"
      title="Real-time 16-band FFT spectrum & peak hold"
      style={{
        width: 92,
        height: 24,
        display: "block",
        flexShrink: 0,
      }}
    />
  );
};
