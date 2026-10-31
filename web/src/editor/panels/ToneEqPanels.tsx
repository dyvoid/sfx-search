import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Power } from "lucide-react";
import { DsRange } from "../../components/DsRange";
import {
  clampCutBand,
  clampToneBand,
  DEFAULT_EQ_SPEC,
  EQ_BAND_IDS,
  EQ_MAX_GAIN_DB,
  EQ_MAX_HZ,
  EQ_MIN_HZ,
  EQ_SLOPES,
  EqBandId,
  EqSpec,
  eqQRange,
  isCutBand,
} from "../audio/dspChain";
import { EQ_BAND_NAMES, EqGraph, formatDb, formatHz } from "../EqGraph";

interface ToneEqPanelsProps {
  eq: EqSpec;
  setEq: React.Dispatch<React.SetStateAction<EqSpec>>;
  /** True when a node drag starts, false when it ends. */
  onDrag: (dragging: boolean) => void;
  sampleRate: number;
  /** The EQ's input (the source) and the trimmed region of it. */
  inputChannels: readonly Float32Array[] | null;
  inputStart: number;
  inputEnd: number;
  isPlaying: boolean;
  getInputPosition: () => number | null;
}

interface EqPreset {
  name: string;
  spec: EqSpec;
}

const D = DEFAULT_EQ_SPEC;
const PRESETS: readonly EqPreset[] = [
  {
    name: "De-Rumble",
    spec: { ...D, hp: { on: true, freqHz: 110, slope: 24 }, low: { ...D.low, gainDb: -3 } },
  },
  {
    name: "Warm Ambience",
    spec: {
      ...D,
      hp: { on: true, freqHz: 60, slope: 12 },
      high: { ...D.high, gainDb: -6 },
      lp: { on: true, freqHz: 2400, slope: 12 },
    },
  },
  {
    name: "Radio Comms",
    spec: {
      ...D,
      hp: { on: true, freqHz: 420, slope: 24 },
      mid: { ...D.mid, freqHz: 1400, gainDb: 6, q: 1.8 },
      lp: { on: true, freqHz: 3400, slope: 24 },
    },
  },
];

/** Log slider positions 0..1000 for frequency and Q. */
const POS_MAX = 1000;
const logToPos = (v: number, lo: number, hi: number): number =>
  Math.round((Math.log(v / lo) / Math.log(hi / lo)) * POS_MAX);
const posToLog = (p: number, lo: number, hi: number): number =>
  lo * Math.pow(hi / lo, p / POS_MAX);

/** Parse a typed value: "1.2k", "1200 Hz", "-3 dB". */
function parseTyped(text: string): number | null {
  const t = text.trim().toLowerCase().replace(",", ".");
  const n = parseFloat(t);
  if (!Number.isFinite(n)) {
    return null;
  }
  return /\d\s*k/.test(t) ? n * 1000 : n;
}

interface ValueFieldProps {
  label: string;
  text: string;
  onCommit: (value: number) => void;
}

/** A readout that turns into a text field on click, for typing an exact value. */
const ValueField: React.FC<ValueFieldProps> = ({ label, text, onCommit }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelRef = useRef(false);

  if (draft === null) {
    return (
      <button
        type="button"
        className="sfx-val-readout sfx-eq-value ds-tnum"
        aria-label={`${label}: ${text}. Click to type a value`}
        onClick={() => {
          cancelRef.current = false;
          setDraft(text);
        }}
      >
        {text}
      </button>
    );
  }
  const commit = () => {
    const v = parseTyped(draft);
    if (!cancelRef.current && v !== null) {
      onCommit(v);
    }
    setDraft(null);
  };
  return (
    <input
      className="sfx-num-input sfx-eq-value-input"
      aria-label={label}
      autoFocus
      value={draft}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          cancelRef.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
};

interface PresetMenuProps {
  onPick: (spec: EqSpec) => void;
}

const PresetMenu: React.FC<PresetMenuProps> = ({ onPick }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    wrapRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(
      wrapRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []
    );
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // an open menu owns Escape; keep it from the Studio
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      items[e.key === "Home" ? 0 : items.length - 1]?.focus();
    }
  };

  return (
    <div ref={wrapRef} className="sfx-eq-menu-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="ds-btn ds-btn-ghost ds-btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Presets
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="ds-menu sfx-eq-menu" role="menu" aria-label="EQ presets" onKeyDown={onMenuKeyDown}>
          {PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              role="menuitem"
              className="ds-menu-item"
              onClick={() => {
                onPick(p.spec);
                setOpen(false);
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

function pillSummary(eq: EqSpec, id: EqBandId): string {
  if (isCutBand(id)) {
    return formatHz(eq[id].freqHz);
  }
  return formatDb(eq[id].gainDb);
}

interface BandEditorProps {
  eq: EqSpec;
  id: EqBandId;
  setEq: React.Dispatch<React.SetStateAction<EqSpec>>;
}

/** Every setting of the selected band. */
const BandEditor: React.FC<BandEditorProps> = ({ eq, id, setEq }) => {
  const name = EQ_BAND_NAMES[id];
  const band = eq[id];

  const setFreq = (hz: number) =>
    setEq((s) =>
      isCutBand(id)
        ? { ...s, [id]: clampCutBand({ ...s[id], freqHz: hz }) }
        : { ...s, [id]: clampToneBand({ ...s[id], freqHz: hz }) }
    );

  const freqRow = (
    <div className="sfx-rack-row">
      <label className="sfx-rack-label">{isCutBand(id) ? "Cutoff" : "Frequency"}</label>
      <div className="sfx-rack-control-inline">
        <DsRange
          aria-label={`${name} frequency`}
          min={0}
          max={POS_MAX}
          step={1}
          value={logToPos(band.freqHz, EQ_MIN_HZ, EQ_MAX_HZ)}
          onChange={(e) => setFreq(posToLog(Number(e.target.value), EQ_MIN_HZ, EQ_MAX_HZ))}
        />
        <ValueField label={`${name} frequency`} text={formatHz(band.freqHz)} onCommit={setFreq} />
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (isCutBand(id)) {
    const cut = eq[id];
    body = (
      <>
        {freqRow}
        <div className="sfx-rack-row">
          <label className="sfx-rack-label">Slope</label>
          <div className="sfx-pill-group" role="group" aria-label={`${name} slope`}>
            {EQ_SLOPES.map((slope) => (
              <button
                key={slope}
                type="button"
                aria-pressed={cut.slope === slope}
                className={`sfx-choice-pill ${cut.slope === slope ? "active" : ""}`}
                onClick={() => setEq((s) => ({ ...s, [id]: { ...s[id], slope } }))}
              >
                {slope}
              </button>
            ))}
            <span className="sfx-rack-hint">dB/oct</span>
          </div>
        </div>
      </>
    );
  } else {
    const tone = eq[id];
    const [qMin, qMax] = eqQRange(tone);
    const setTone = (patch: Partial<typeof tone>) =>
      setEq((s) => ({ ...s, [id]: clampToneBand({ ...s[id as "low"], ...patch }) }));
    body = (
      <>
        {id !== "mid" && (
          <div className="sfx-rack-row">
            <label className="sfx-rack-label">Type</label>
            <div className="sfx-pill-group" role="group" aria-label={`${name} filter type`}>
              {(["bell", "shelf"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={tone.type === type}
                  className={`sfx-choice-pill ${tone.type === type ? "active" : ""}`}
                  onClick={() => setTone({ type })}
                >
                  {type === "bell" ? "Bell" : `${name} Shelf`}
                </button>
              ))}
            </div>
          </div>
        )}
        {freqRow}
        <div className="sfx-rack-row">
          <label className="sfx-rack-label">Gain</label>
          <div className="sfx-rack-control-inline">
            <DsRange
              aria-label={`${name} gain`}
              min={-EQ_MAX_GAIN_DB}
              max={EQ_MAX_GAIN_DB}
              step={0.1}
              value={tone.gainDb}
              onChange={(e) => setTone({ gainDb: Number(e.target.value) })}
            />
            <ValueField
              label={`${name} gain`}
              text={formatDb(tone.gainDb)}
              onCommit={(gainDb) => setTone({ gainDb })}
            />
          </div>
        </div>
        <div className="sfx-rack-row">
          <label className="sfx-rack-label">Q</label>
          <div className="sfx-rack-control-inline">
            <DsRange
              aria-label={`${name} Q`}
              min={0}
              max={POS_MAX}
              step={1}
              value={logToPos(tone.q, qMin, qMax)}
              onChange={(e) => setTone({ q: posToLog(Number(e.target.value), qMin, qMax) })}
            />
            <ValueField
              label={`${name} Q`}
              text={tone.q.toFixed(2)}
              onCommit={(q) => setTone({ q })}
            />
          </div>
        </div>
      </>
    );
  }

  return (
    <section className="sfx-rack-card sfx-eq-editor" aria-label={`${name} band settings`}>
      <div className="sfx-rack-card-head">
        <span className="ds-panel-title">{name} band</span>
        {!band.on && <span className="ds-badge ds-badge-neutral">Off</span>}
      </div>
      <div className="sfx-rack-fields">{body}</div>
    </section>
  );
};

/**
 * Tone & EQ module of the edit page: a five-band parametric EQ (HP, Low, Mid,
 * High, LP in series) with live spectra. The graph takes ~2/3, the selected
 * band's settings the rest; they stack when the rack is narrow.
 */
export const ToneEqPanels: React.FC<ToneEqPanelsProps> = ({
  eq,
  setEq,
  onDrag,
  sampleRate,
  inputChannels,
  inputStart,
  inputEnd,
  isPlaying,
  getInputPosition,
}) => {
  const [selected, setSelected] = useState<EqBandId>("low");

  return (
    <div className="sfx-eq-module">
      <section className="sfx-rack-card sfx-eq-main">
        <div className="sfx-rack-card-head">
          <div className="sfx-eq-head-left">
            <span className="ds-panel-title">Parametric EQ</span>
            <button
              type="button"
              role="switch"
              aria-checked={eq.on}
              aria-label="EQ on"
              className="ds-switch-item sfx-eq-switch"
              onClick={() => setEq((s) => ({ ...s, on: !s.on }))}
            >
              <span className={`ds-switch-track ${eq.on ? "on" : ""}`}>
                <span className="ds-switch-thumb" />
              </span>
            </button>
          </div>
          <div className="sfx-eq-head-right">
            <span className="sfx-eq-legend sfx-rack-hint">
              <i className="in" />
              In
              <i className="out" />
              Out
              <span>· {isPlaying ? "live" : "clip average"}</span>
            </span>
            <PresetMenu onPick={setEq} />
          </div>
        </div>
        <EqGraph
          eq={eq}
          setEq={setEq}
          selected={selected}
          onSelect={setSelected}
          onDrag={onDrag}
          sampleRate={sampleRate}
          inputChannels={inputChannels}
          inputStart={inputStart}
          inputEnd={inputEnd}
          isPlaying={isPlaying}
          getInputPosition={getInputPosition}
        />
        <div className="sfx-eq-pills" role="group" aria-label="EQ bands">
          {EQ_BAND_IDS.map((id) => {
            const on = eq[id].on;
            return (
              <div
                key={id}
                className={`sfx-eq-pill ${selected === id ? "active" : ""} ${on ? "" : "off"}`}
              >
                <button
                  type="button"
                  className="sfx-eq-pill-main"
                  aria-pressed={selected === id}
                  aria-label={`Select ${EQ_BAND_NAMES[id]} band`}
                  onClick={() => setSelected(id)}
                >
                  <span className="sfx-eq-pill-name">{EQ_BAND_NAMES[id]}</span>
                  <span className="sfx-eq-pill-sub ds-tnum">{pillSummary(eq, id)}</span>
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={`${EQ_BAND_NAMES[id]} band on`}
                  className="sfx-eq-power"
                  onClick={() => setEq((s) => ({ ...s, [id]: { ...s[id], on: !s[id].on } }))}
                >
                  <Power size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </section>
      <BandEditor eq={eq} id={selected} setEq={setEq} />
    </div>
  );
};
