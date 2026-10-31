import React from "react";
import { Dices, Play, Replace, Square } from "lucide-react";
import { GeneratedVariation } from "../audio/variations";
import { VariationWaveCardCanvas } from "../SeamScope";

interface TakesPanelProps {
  variations: GeneratedVariation[];
  activeVarIdx: number;
  playingVarIdx: number | null;
  varPlayRatio: number | null;
  takeCount: number;
  setTakeCount: (n: number) => void;
  canGenerate: boolean;
  /** The edit changed after these takes were generated. */
  stale: boolean;
  onGenerate: () => void;
  onAudition: (v: GeneratedVariation, idx: number) => void;
  onStop: () => void;
  onReroll: (idx: number) => void;
  onToggleSelected: (idx: number) => void;
  onReplaceSource: (v: GeneratedVariation) => void;
  onDragStart: (e: React.DragEvent, v: GeneratedVariation) => void;
  gridRef: React.RefObject<HTMLDivElement>;
}

const signedSt = (st: number): string => (st >= 0 ? `+${st.toFixed(1)}` : st.toFixed(1));

/** Variations page, full width: the generated round-robin takes. */
export const TakesPanel: React.FC<TakesPanelProps> = (p) => {
  const selectedCount = p.variations.filter((v) => v.selected).length;
  return (
    <section className="sfx-rack-card sfx-takes-panel" aria-label="Round-robin takes">
      <div className="sfx-rack-card-head">
        <span className="ds-panel-title">Round-Robin Takes</span>
        {p.variations.length > 0 && (
          <span className="sfx-rack-hint ds-tnum">
            {selectedCount} of {p.variations.length} selected
          </span>
        )}
        <div className="sfx-takes-head-actions">
          <span className="sfx-rack-hint">Takes</span>
          <input
            aria-label="Take count"
            type="number"
            min={1}
            max={12}
            step={1}
            value={p.takeCount}
            onChange={(e) => p.setTakeCount(Math.max(1, Math.min(12, Number(e.target.value) || 6)))}
            className="sfx-num-input ds-tnum"
            style={{ width: 56 }}
          />
          <button
            type="button"
            disabled={!p.canGenerate}
            onClick={p.onGenerate}
            className="ds-btn ds-btn-primary ds-btn-sm"
            title="Generate the takes (G)"
          >
            <Dices size={13} />
            Generate
          </button>
        </div>
      </div>

      {p.stale && (
        <div className="sfx-takes-stale" role="status">
          <span>The edit changed after these takes were made.</span>
          <button type="button" onClick={p.onGenerate} className="ds-btn ds-btn-secondary ds-btn-sm">
            Regenerate
          </button>
        </div>
      )}

      {p.variations.length === 0 ? (
        <div className="sfx-candidate-empty">
          Set the variation amounts, then generate takes (<kbd className="sfx-kbd">G</kbd>).
        </div>
      ) : (
        <div ref={p.gridRef} className="sfx-var-takes-grid">
          {p.variations.map((v, idx) => {
            const isAct = idx === p.activeVarIdx;
            const isTakePlaying = idx === p.playingVarIdx;
            return (
              <div
                key={v.id}
                draggable
                onDragStart={(e) => p.onDragStart(e, v)}
                onClick={() => p.onAudition(v, idx)}
                className={`sfx-var-take-card ${isAct ? "active" : ""} ${
                  v.selected ? "selected" : ""
                }`}
                title="Click to play from the start · Drag into your DAW"
              >
                <div className="sfx-var-take-top" onClick={(e) => e.stopPropagation()}>
                  <label
                    role="checkbox"
                    aria-checked={v.selected}
                    aria-label={`Include take ${idx + 1}`}
                    tabIndex={0}
                    className="ds-check"
                    onKeyDown={(e) => {
                      if (e.key === " " || e.key === "Enter") {
                        e.preventDefault();
                        if (!e.repeat) {
                          e.currentTarget.click();
                        }
                      }
                    }}
                    onClick={() => p.onToggleSelected(idx)}
                  >
                    <div className={`ds-checkbox ${v.selected ? "on" : ""}`}>
                      {v.selected && <div className="ds-checkbox-inner" />}
                    </div>
                    <span className="sfx-var-take-title">Take {idx + 1}</span>
                  </label>
                  <span className="sfx-var-take-meta ds-tnum">
                    {v.durationS.toFixed(2)} s · {signedSt(v.meanSemitones)} st
                  </span>
                  <div className="sfx-var-take-actions">
                    <button
                      type="button"
                      onClick={() => p.onAudition(v, idx)}
                      className="sfx-var-mini-btn"
                      title="Play this take from the start"
                      aria-label={`Play take ${idx + 1}`}
                    >
                      <Play size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => p.onReroll(idx)}
                      className="sfx-var-mini-btn"
                      title="Re-roll this take"
                      aria-label={`Re-roll take ${idx + 1}`}
                    >
                      <Dices size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => p.onReplaceSource(v)}
                      className="ds-btn ds-btn-ghost ds-btn-sm sfx-replace-btn"
                      title="This take becomes the file you edit. Your current edits, loop settings and takes are cleared. You can undo for a few seconds."
                    >
                      <Replace size={12} />
                      Replace source
                    </button>
                  </div>
                </div>

                <div className="sfx-var-wave-wrap">
                  <VariationWaveCardCanvas
                    peaks={v.peaks}
                    pitchCurve={v.pitchCurve}
                    volumeCurve={v.volumeCurve}
                    isActive={isAct}
                    playheadRatio={isTakePlaying ? p.varPlayRatio : null}
                  />
                  {isTakePlaying && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        p.onStop();
                      }}
                      className="sfx-var-stop-corner-btn"
                      title="Stop playing take"
                      aria-label="Stop playing take"
                    >
                      <Square size={10} fill="currentColor" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
