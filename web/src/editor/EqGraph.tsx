import React, { useCallback, useEffect, useMemo, useRef } from "react";
import {
  clampCutBand,
  clampToneBand,
  EQ_BAND_IDS,
  EQ_MAX_GAIN_DB,
  EQ_MAX_HZ,
  EQ_MIN_HZ,
  EqBandId,
  EqSpec,
  eqBandResponseCurveDb,
  eqResponseCurveDb,
  isCutBand,
  zeroEqBand,
} from "./audio/dspChain";
import { averageSpectrumDb, binsToCurveDb, frameSpectrumDb } from "./audio/spectrum";
import { readTokenColor } from "./SeamScope";

export const EQ_BAND_NAMES: Record<EqBandId, string> = {
  hp: "High-Pass",
  low: "Low",
  mid: "Mid",
  high: "High",
  lp: "Low-Pass",
};

const NODE_LABELS: Record<EqBandId, string> = {
  hp: "HP",
  low: "L",
  mid: "M",
  high: "H",
  lp: "LP",
};

export function formatHz(hz: number): string {
  if (hz >= 1000) {
    return `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz`;
  }
  return `${Math.round(hz)} Hz`;
}

export function formatDb(db: number): string {
  const v = Math.abs(db) < 0.05 ? 0 : db;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
}

const LOG_MIN = Math.log10(EQ_MIN_HZ);
const LOG_SPAN = Math.log10(EQ_MAX_HZ) - LOG_MIN;
const freqToRatio = (hz: number): number => (Math.log10(hz) - LOG_MIN) / LOG_SPAN;
const gainToRatio = (db: number): number => 0.5 - db / (2 * EQ_MAX_GAIN_DB);

/** Plot area inside the graph box, leaving room for the axis labels. */
const PLOT_INSET = { left: 30, right: 10, top: 8, bottom: 20 };

/** The spectrum's own vertical scale (dBFS, after a +3 dB/oct tilt about 1 kHz). */
const SPEC_FLOOR_DB = -96;
const SPEC_CEIL_DB = -6;
/** How fast the live spectrum falls back (dB per frame); rises are instant. */
const SPEC_FALL_DB = 1.2;

const CURVE_POINTS = 280;
const CURVE_FREQS = Float64Array.from({ length: CURVE_POINTS }, (_, i) =>
  Math.pow(10, LOG_MIN + (i / (CURVE_POINTS - 1)) * LOG_SPAN)
);

const FREQ_GRID: readonly [number, string][] = [
  [50, "50"],
  [100, "100"],
  [200, "200"],
  [500, "500"],
  [1000, "1k"],
  [2000, "2k"],
  [5000, "5k"],
  [10000, "10k"],
];
const GAIN_GRID = [12, 6, 0, -6, -12];

/** Keyboard steps: a semitone in frequency, half a dB, a sixth of an octave in Q. */
const KEY_FREQ_RATIO = Math.pow(2, 1 / 12);
const KEY_FINE_FREQ_RATIO = Math.pow(2, 1 / 48);
const Q_STEP_RATIO = Math.pow(2, 1 / 6);

interface EqGraphProps {
  eq: EqSpec;
  setEq: React.Dispatch<React.SetStateAction<EqSpec>>;
  selected: EqBandId;
  onSelect: (id: EqBandId) => void;
  /** True when a node drag starts, false when it ends. */
  onDrag: (dragging: boolean) => void;
  sampleRate: number;
  inputChannels: readonly Float32Array[] | null;
  inputStart: number;
  inputEnd: number;
  isPlaying: boolean;
  getInputPosition: () => number | null;
}

interface Palette {
  grid: string;
  text: string;
  curve: string;
  curveOff: string;
  bandFill: string;
  specIn: string;
  specOut: string;
  specOutFill: string;
}

function readPalette(): Palette {
  return {
    grid: readTokenColor("--border-subtle", "rgba(255, 255, 255, 0.1)"),
    text: readTokenColor("--text-tertiary", "rgba(200, 210, 225, 0.55)"),
    curve: readTokenColor("--accent-1-400", "#e6b85c"),
    curveOff: readTokenColor("--text-disabled", "rgba(200, 210, 225, 0.35)"),
    bandFill: readTokenColor("--accent-1-muted-bg", "rgba(230, 184, 92, 0.18)"),
    specIn: readTokenColor("--accent-2-600", "#3a8597"),
    specOut: readTokenColor("--accent-2-400", "#58b5c9"),
    specOutFill: readTokenColor("--accent-2-muted-bg", "rgba(88, 181, 201, 0.16)"),
  };
}

function tiltDb(hz: number): number {
  return 3 * Math.log2(hz / 1000);
}

/** Change one band, clamped to its ranges. */
function withBand(spec: EqSpec, id: EqBandId, patch: Record<string, unknown>): EqSpec {
  if (isCutBand(id)) {
    return { ...spec, [id]: clampCutBand({ ...spec[id], ...patch }) };
  }
  return { ...spec, [id]: clampToneBand({ ...spec[id], ...patch }) };
}

/**
 * The EQ display: grid, input/output spectra, the response curve and one
 * draggable node per band. The output spectrum is the input plus the EQ
 * response, so it follows every change immediately.
 */
export const EqGraph: React.FC<EqGraphProps> = ({
  eq,
  setEq,
  selected,
  onSelect,
  onDrag,
  sampleRate,
  inputChannels,
  inputStart,
  inputEnd,
  isPlaying,
  getInputPosition,
}) => {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paletteRef = useRef<Palette | null>(null);
  const liveRef = useRef<Float32Array | null>(null);

  const averageDb = useMemo(() => {
    if (!inputChannels || inputChannels.length === 0 || inputEnd <= inputStart) {
      return null;
    }
    const bins = averageSpectrumDb(inputChannels, inputStart, inputEnd);
    return binsToCurveDb(bins, sampleRate, CURVE_FREQS);
  }, [inputChannels, inputStart, inputEnd, sampleRate]);

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    const g = cv?.getContext("2d");
    if (!cv || !g) {
      return;
    }
    const pal = (paletteRef.current ??= readPalette());
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 600;
    const h = cv.clientHeight || 220;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const px = PLOT_INSET.left;
    const py = PLOT_INSET.top;
    const pw = Math.max(1, w - PLOT_INSET.left - PLOT_INSET.right);
    const ph = Math.max(1, h - PLOT_INSET.top - PLOT_INSET.bottom);
    const xAt = (i: number): number => px + (i / (CURVE_POINTS - 1)) * pw;
    const yGain = (db: number): number =>
      py + gainToRatio(Math.max(-EQ_MAX_GAIN_DB, Math.min(EQ_MAX_GAIN_DB, db))) * ph;
    const ySpec = (db: number, i: number): number => {
      const t = (db + tiltDb(CURVE_FREQS[i]) - SPEC_FLOOR_DB) / (SPEC_CEIL_DB - SPEC_FLOOR_DB);
      return py + ph - Math.max(0, Math.min(1, t)) * ph;
    };

    // Grid and axis labels
    g.strokeStyle = pal.grid;
    g.lineWidth = 1;
    g.font = '11px "DM Mono", ui-monospace, monospace';
    g.fillStyle = pal.text;
    g.textBaseline = "middle";
    g.beginPath();
    for (const db of GAIN_GRID) {
      const y = Math.round(yGain(db)) + 0.5;
      g.moveTo(px, y);
      g.lineTo(px + pw, y);
      const lbl = db > 0 ? `+${db}` : `${db}`;
      g.fillText(lbl, px - 6 - g.measureText(lbl).width, y);
    }
    g.textBaseline = "alphabetic";
    for (const [hz, lbl] of FREQ_GRID) {
      const x = Math.round(px + freqToRatio(hz) * pw) + 0.5;
      g.moveTo(x, py);
      g.lineTo(x, py + ph);
      g.fillText(lbl, x - g.measureText(lbl).width / 2, h - 5);
    }
    g.stroke();

    const response = eqResponseCurveDb(eq, CURVE_FREQS, sampleRate);

    // Spectra: input as a dim outline, output (input + EQ) filled.
    const input = liveRef.current ?? averageDb;
    if (input) {
      if (eq.on) {
        g.beginPath();
        for (let i = 0; i < CURVE_POINTS; i++) {
          const y = ySpec(input[i], i);
          if (i === 0) {
            g.moveTo(xAt(i), y);
          } else {
            g.lineTo(xAt(i), y);
          }
        }
        g.strokeStyle = pal.specIn;
        g.lineWidth = 1;
        g.stroke();
      }
      g.beginPath();
      g.moveTo(px, py + ph);
      for (let i = 0; i < CURVE_POINTS; i++) {
        g.lineTo(xAt(i), ySpec(input[i] + response[i], i));
      }
      g.lineTo(px + pw, py + ph);
      g.closePath();
      g.fillStyle = pal.specOutFill;
      g.fill();
      g.beginPath();
      for (let i = 0; i < CURVE_POINTS; i++) {
        const y = ySpec(input[i] + response[i], i);
        if (i === 0) {
          g.moveTo(xAt(i), y);
        } else {
          g.lineTo(xAt(i), y);
        }
      }
      g.strokeStyle = pal.specOut;
      g.lineWidth = 1;
      g.stroke();
    }

    // The selected band's own shape, shaded against 0 dB.
    const band = eq[selected];
    if (eq.on && band.on) {
      const own = eqBandResponseCurveDb(eq, selected, CURVE_FREQS, sampleRate);
      g.beginPath();
      g.moveTo(px, yGain(0));
      for (let i = 0; i < CURVE_POINTS; i++) {
        g.lineTo(xAt(i), yGain(own[i]));
      }
      g.lineTo(px + pw, yGain(0));
      g.closePath();
      g.fillStyle = pal.bandFill;
      g.fill();
    }

    // Composite response
    g.beginPath();
    for (let i = 0; i < CURVE_POINTS; i++) {
      const y = yGain(response[i]);
      if (i === 0) {
        g.moveTo(xAt(i), y);
      } else {
        g.lineTo(xAt(i), y);
      }
    }
    g.strokeStyle = eq.on ? pal.curve : pal.curveOff;
    g.lineWidth = 2;
    g.setLineDash(eq.on ? [] : [4, 4]);
    g.stroke();
    g.setLineDash([]);
  }, [eq, selected, sampleRate, averageDb]);

  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) {
      return;
    }
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  // Live spectrum while playing: the input frame under the playhead, with a
  // slow fall so it reads as a curve. Stopped: the clip average.
  useEffect(() => {
    if (!isPlaying || !inputChannels || inputChannels.length === 0) {
      liveRef.current = null;
      drawRef.current();
      return;
    }
    let raf = 0;
    const tick = () => {
      const pos = getInputPosition();
      if (pos !== null) {
        const frame = binsToCurveDb(
          frameSpectrumDb(inputChannels, pos),
          sampleRate,
          CURVE_FREQS
        );
        const prev = liveRef.current;
        if (prev) {
          for (let i = 0; i < frame.length; i++) {
            frame[i] = Math.max(frame[i], prev[i] - SPEC_FALL_DB);
          }
        }
        liveRef.current = frame;
        drawRef.current();
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [isPlaying, inputChannels, sampleRate, getInputPosition]);

  // Node dragging
  const dragRef = useRef<{
    id: EqBandId;
    pointerId: number;
    x0: number;
    y0: number;
    freq0: number;
    gain0: number;
    plotW: number;
    plotH: number;
    moved: boolean;
  } | null>(null);

  const onNodePointerDown = (e: React.PointerEvent<HTMLDivElement>, id: EqBandId) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect(id);
    const plot = e.currentTarget.parentElement?.getBoundingClientRect();
    const band = eq[id];
    dragRef.current = {
      id,
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      freq0: band.freqHz,
      gain0: isCutBand(id) ? 0 : eq[id].gainDb,
      plotW: Math.max(1, plot?.width ?? 1),
      plotH: Math.max(1, plot?.height ?? 1),
      moved: false,
    };
  };

  const onNodePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) {
      return;
    }
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 3) {
        return;
      }
      d.moved = true;
      onDrag(true);
    }
    // Shift drags at a quarter of the speed, for fine moves.
    const k = e.shiftKey ? 0.25 : 1;
    const freqHz = d.freq0 * Math.pow(10, (dx / d.plotW) * LOG_SPAN * k);
    const patch: Record<string, number> = { freqHz };
    if (!isCutBand(d.id)) {
      patch.gainDb = d.gain0 - (dy / d.plotH) * 2 * EQ_MAX_GAIN_DB * k;
    }
    setEq((s) => withBand(s, d.id, patch));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) {
      return;
    }
    dragRef.current = null;
    if (d.moved) {
      onDrag(false);
    }
  };

  const onNodeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, id: EqBandId) => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    let patch: Record<string, number> | null = null;
    const band = eq[id];
    const ratio = e.shiftKey ? KEY_FINE_FREQ_RATIO : KEY_FREQ_RATIO;
    switch (e.code) {
      case "ArrowLeft":
        patch = { freqHz: band.freqHz / ratio };
        break;
      case "ArrowRight":
        patch = { freqHz: band.freqHz * ratio };
        break;
      case "ArrowUp":
      case "ArrowDown":
        if (!isCutBand(id)) {
          const step = (e.shiftKey ? 0.1 : 0.5) * (e.code === "ArrowUp" ? 1 : -1);
          patch = { gainDb: eq[id].gainDb + step };
        }
        break;
      case "PageUp":
      case "PageDown":
        if (!isCutBand(id)) {
          const q = eq[id].q;
          patch = { q: e.code === "PageUp" ? q * Q_STEP_RATIO : q / Q_STEP_RATIO };
        }
        break;
      case "Digit0":
      case "Numpad0":
        e.preventDefault();
        e.stopPropagation();
        setEq((s) => zeroEqBand(s, id));
        return;
    }
    if (!patch) {
      return;
    }
    // Handled here: keep the Studio's own arrow / page handling out of it.
    e.preventDefault();
    e.stopPropagation();
    const p = patch;
    setEq((s) => withBand(s, id, p));
  };

  // Wheel over a bell or shelf node changes its Q. A native listener, since
  // React's wheel handlers are passive and could not keep the rack from scrolling.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      const node = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-band]") : null;
      const id = node?.dataset.band as EqBandId | undefined;
      if (!id || isCutBand(id) || e.deltaY === 0) {
        return;
      }
      e.preventDefault();
      const steps = -e.deltaY / 100;
      setEq((s) => withBand(s, id, { q: s[id].q * Math.pow(Q_STEP_RATIO, steps) }));
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [setEq]);

  return (
    <div ref={boxRef} className="sfx-eq-graph">
      <canvas ref={canvasRef} className="sfx-eq-graph-canvas" aria-hidden="true" />
      <div
        className="sfx-eq-plot"
        style={{
          left: PLOT_INSET.left,
          right: PLOT_INSET.right,
          top: PLOT_INSET.top,
          bottom: PLOT_INSET.bottom,
        }}
      >
        {EQ_BAND_IDS.map((id) => {
          const band = eq[id];
          const cut = isCutBand(id);
          const gainDb = cut ? 0 : eq[id].gainDb;
          const valueText = cut
            ? `${formatHz(band.freqHz)}, ${eq[id].slope} dB/oct`
            : `${formatHz(band.freqHz)}, ${formatDb(gainDb)}, Q ${eq[id].q.toFixed(2)}`;
          return (
            <div
              key={id}
              data-band={id}
              role="slider"
              tabIndex={0}
              aria-label={`${EQ_BAND_NAMES[id]} band`}
              aria-valuemin={EQ_MIN_HZ}
              aria-valuemax={EQ_MAX_HZ}
              aria-valuenow={Math.round(band.freqHz)}
              aria-valuetext={band.on ? valueText : `${valueText}, off`}
              className={`sfx-eq-node ${band.on ? "on" : "off"} ${
                selected === id ? "selected" : ""
              }`}
              style={{
                left: `${freqToRatio(band.freqHz) * 100}%`,
                top: `${gainToRatio(gainDb) * 100}%`,
              }}
              onPointerDown={(e) => onNodePointerDown(e, id)}
              onPointerMove={onNodePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={() => setEq((s) => zeroEqBand(s, id))}
              onFocus={() => onSelect(id)}
              onKeyDown={(e) => onNodeKeyDown(e, id)}
            >
              {NODE_LABELS[id]}
            </div>
          );
        })}
      </div>
    </div>
  );
};
