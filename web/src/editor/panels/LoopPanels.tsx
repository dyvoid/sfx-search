import React from "react";
import { Wand2 } from "lucide-react";
import { DsRange } from "../../components/DsRange";
import { BakeMode, FadeCurve } from "../audio/loopdsp";
import { LoopCandidate } from "../audio/search";
import { SeamScope } from "../SeamScope";
import { LabelWithTip } from "./LabelWithTip";

export type LoopSearchMode = "auto" | "pairs" | "fixed-end";

interface LoopPanelsProps {
  sampleRate: number;
  totalDurationS: number;
  loopDurationS: number;
  fadeMs: number;
  setFadeMs: (ms: number) => void;
  fadeCurve: FadeCurve;
  setFadeCurve: (c: FadeCurve) => void;
  bakeMode: BakeMode;
  setBakeMode: (m: BakeMode) => void;
  snapZero: boolean;
  onToggleSnap: () => void;
  onResetLoop: () => void;
  candidates: LoopCandidate[];
  candIndex: number;
  onApplyCandidate: (idx: number) => void;
  onClearCandidates: () => void;
  searching: boolean;
  canSearch: boolean;
  onFindLoops: () => void;
  searchModePref: LoopSearchMode;
  setSearchModePref: (m: LoopSearchMode) => void;
  minLoopSec: number;
  setMinLoopSec: (s: number) => void;
  searchWindowMs: number;
  setSearchWindowMs: (ms: number) => void;
  bakedChannels: Float32Array[] | null;
  fadeSamples: number;
}

/** Loop page rack: crossfade & seam blend, loop finder, seam continuity scope. */
export const LoopPanels: React.FC<LoopPanelsProps> = (p) => (
  <div className="sfx-rack-grid">
    {/* Column 1: Loop Boundaries & Crossfade */}
    <section className="sfx-rack-card">
      <div className="sfx-rack-card-head">
        <span className="ds-panel-title">Crossfade &amp; Seam Blend</span>
        <button
          type="button"
          onClick={p.onResetLoop}
          className="ds-btn ds-btn-ghost ds-btn-sm"
          title="Loop the whole sound again, with the default crossfade"
        >
          Reset loop
        </button>
      </div>

      <div className="sfx-rack-fields">
        <div className="sfx-rack-row">
          <label className="sfx-rack-label">Crossfade (ms)</label>
          <div className="sfx-rack-control-inline">
            <DsRange
              aria-label="Crossfade (ms)"
              min={0}
              max={Math.min(5000, Math.max(100, Math.floor(p.loopDurationS * 500)))}
              step={5}
              value={p.fadeMs}
              onChange={(e) => p.setFadeMs(Number(e.target.value))}
            />
            <input
              aria-label="Crossfade (ms) value"
              type="number"
              min={0}
              max={10000}
              step={10}
              value={Math.round(p.fadeMs)}
              onChange={(e) => p.setFadeMs(Math.max(0, Number(e.target.value) || 0))}
              className="sfx-num-input ds-tnum"
            />
          </div>
        </div>

        <div className="sfx-rack-row">
          <label className="sfx-rack-label">Fade curve</label>
          <div className="sfx-pill-group" role="group" aria-label="Fade curve">
            {(
              [
                ["equal-power", "Equal Power"],
                ["cosine", "Cosine"],
                ["linear", "Linear"],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => p.setFadeCurve(val)}
                className={`sfx-choice-pill ${p.fadeCurve === val ? "active" : ""}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="sfx-rack-row">
          <LabelWithTip
            label="Blend placement"
            tip="Where the join material is taken from. Auto picks per candidate; Pre-roll borrows audio just before loop end, Post-roll just after loop start, Internal crossfades inside the region."
          />
          <div className="sfx-pill-group" role="group" aria-label="Blend placement">
            {(
              [
                ["auto", "Auto"],
                ["pre", "Pre-roll"],
                ["post", "Post-roll"],
                ["head", "Internal"],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => p.setBakeMode(val)}
                className={`sfx-choice-pill ${p.bakeMode === val ? "active" : ""}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="sfx-rack-row">
          <LabelWithTip
            label="Zero-crossing"
            tip="Snapping markers to a rising zero crossing is the safest place for a click-free loop join."
          />
          <label
            role="checkbox"
            aria-checked={p.snapZero}
            tabIndex={0}
            className="ds-check"
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.click();
              }
            }}
            onClick={p.onToggleSnap}
          >
            <div className={`ds-checkbox ${p.snapZero ? "on" : ""}`}>
              {p.snapZero && <div className="ds-checkbox-inner" />}
            </div>
            <span className="ds-check-label" style={{ fontSize: "var(--font-size-xs)" }}>
              Snap markers to rising zero crossings
            </span>
          </label>
        </div>
      </div>
    </section>

    {/* Column 2: Auto-Loop Detection & Candidate Ranking */}
    <section className="sfx-rack-card">
      <div className="sfx-rack-card-head">
        <span className="ds-panel-title">Loop Finder</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {p.candidates.length > 0 && (
            <button
              type="button"
              onClick={p.onClearCandidates}
              className="ds-btn ds-btn-ghost ds-btn-sm"
              title="Clear loop suggestions"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            disabled={!p.canSearch || p.searching}
            onClick={p.onFindLoops}
            className="ds-btn ds-btn-primary ds-btn-sm sfx-find-loops-btn"
            title="Scan audio for seamless loop points (F)"
          >
            <Wand2 size={13} />
            {p.searching ? "Scanning…" : "Find Loops"}
          </button>
        </div>
      </div>

      <div className="sfx-rack-fields">
        <div className="sfx-rack-row">
          <LabelWithTip
            label="Search strategy"
            tip="How candidates are found. Auto tries both; Best Pairs matches loop start and end independently; Match End pins the loop end to the file end."
          />
          <div className="sfx-pill-group" role="group" aria-label="Search strategy">
            {(
              [
                ["auto", "Auto"],
                ["pairs", "Best Pairs (S & E)"],
                ["fixed-end", "Match End (E)"],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => p.setSearchModePref(val)}
                className={`sfx-choice-pill ${p.searchModePref === val ? "active" : ""}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="sfx-rack-row">
          <LabelWithTip label="Min loop length (s)" tip="Rejects candidates shorter than this." />
          <div className="sfx-rack-control-inline">
            <input
              aria-label="Min loop length (s)"
              type="number"
              min={0.1}
              max={Math.max(1, p.totalDurationS)}
              step={0.5}
              value={p.minLoopSec}
              onChange={(e) => p.setMinLoopSec(Math.max(0.1, Number(e.target.value) || 0.5))}
              className="sfx-num-input ds-tnum"
            />
          </div>
        </div>

        <div className="sfx-rack-row">
          <LabelWithTip
            label="Search window (ms)"
            tip="How far the scanner searches around each promising point."
          />
          <div className="sfx-rack-control-inline">
            <input
              aria-label="Window (ms)"
              type="number"
              min={50}
              max={4000}
              step={50}
              value={p.searchWindowMs}
              onChange={(e) => p.setSearchWindowMs(Math.max(50, Number(e.target.value) || 400))}
              className="sfx-num-input ds-tnum"
            />
          </div>
        </div>

        {/* Candidate chips */}
        <div className="sfx-candidate-grid">
          {p.candidates.length === 0 ? (
            <div className="sfx-candidate-empty">
              Click <strong>Find Loops</strong> (or press <kbd className="sfx-kbd">F</kbd>) to
              scan for phase-aligned loop regions.
            </div>
          ) : (
            p.candidates.map((c, idx) => {
              const pct = Math.round(c.score * 100);
              const lenS = ((c.end - c.start) / p.sampleRate).toFixed(2);
              return (
                <button
                  key={`${c.start}-${c.end}-${idx}`}
                  type="button"
                  onClick={() => p.onApplyCandidate(idx)}
                  className={`sfx-candidate-chip ds-tnum ${idx === p.candIndex ? "active" : ""}`}
                  title={`Start: ${(c.start / p.sampleRate).toFixed(2)}s → End: ${(
                    c.end / p.sampleRate
                  ).toFixed(2)}s`}
                >
                  <span className="rank">#{idx + 1}</span>
                  <span className="score">{pct}%</span>
                  <span className="dur">{lenS}s</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </section>

    {/* Column 3: Real-Time Seam Phase Scope */}
    <section className="sfx-rack-card">
      <div className="sfx-rack-card-head">
        <span className="ds-panel-title">Seam Continuity Scope</span>
      </div>
      <SeamScope
        bakedChannels={p.bakedChannels}
        sampleRate={p.sampleRate}
        fadeSamples={p.fadeSamples}
      />
      <div className="sfx-seam-caption">
        <span>
          The last 25 ms of the loop (
          <strong style={{ color: "var(--danger-400)" }}>Tail</strong>) running into its first 25
          ms (<strong style={{ color: "var(--success-500)" }}>Head</strong>).
        </span>
      </div>
    </section>
  </div>
);
