import React from "react";
import { Wand2 } from "lucide-react";
import { DsRange } from "../../components/DsRange";
import { ShaperSpec } from "../audio/dspChain";
import { LabelWithTip } from "./LabelWithTip";

interface TrimGainPanelsProps {
  shaper: ShaperSpec;
  setShaper: React.Dispatch<React.SetStateAction<ShaperSpec>>;
  /** Length of the untrimmed source, in samples. */
  rawTotalSamples: number;
  sampleRate: number;
  /** Length of the trimmed sound, in seconds. */
  totalDurationS: number;
  canAutoTrim: boolean;
  onAutoTrim: () => void;
}

/** Trim & Gain module of the edit page: trim, fades, gain. Edits apply live. */
export const TrimGainPanels: React.FC<TrimGainPanelsProps> = ({
  shaper,
  setShaper,
  rawTotalSamples,
  sampleRate,
  totalDurationS,
  canAutoTrim,
  onAutoTrim,
}) => {
  const rawMs = (rawTotalSamples / sampleRate) * 1000;
  const fadeMax = Math.min(10000, Math.max(100, Math.floor(totalDurationS * 500)));
  return (
    <div className="sfx-rack-grid">
      {/* Column 1: Crop / Trim Region */}
      <section className="sfx-rack-card">
        <div className="sfx-rack-card-head">
          <span className="ds-panel-title">Trim</span>
          <button
            type="button"
            disabled={!canAutoTrim}
            onClick={onAutoTrim}
            className="ds-btn ds-btn-secondary ds-btn-sm"
            title="Automatically detect and crop leading and trailing silence below -50 dBFS"
          >
            <Wand2 size={12} />
            Auto-Trim Silence
          </button>
        </div>

        <div className="sfx-rack-fields">
          <div className="sfx-rack-row">
            <LabelWithTip
              label="Trim Start (ms)"
              tip="Crops audio from the beginning of the file. You can also drag the green IN handle directly on the waveform."
            />
            <div className="sfx-rack-control-inline">
              <DsRange
                aria-label="Trim Start (ms)"
                min={0}
                max={Math.max(100, Math.floor(rawMs - shaper.trimEndMs - 20))}
                step={5}
                value={shaper.trimStartMs}
                onChange={(e) =>
                  setShaper((s) => ({
                    ...s,
                    trimStartMs: Math.max(0, Number(e.target.value)),
                  }))
                }
              />
              <input
                aria-label="Trim Start (ms) value"
                type="number"
                min={0}
                max={Math.floor(rawMs)}
                step={10}
                value={shaper.trimStartMs}
                onChange={(e) =>
                  setShaper((s) => ({
                    ...s,
                    trimStartMs: Math.max(0, Number(e.target.value) || 0),
                  }))
                }
                className="sfx-num-input ds-tnum"
              />
            </div>
          </div>

          <div className="sfx-rack-row">
            <LabelWithTip
              label="Trim End (ms)"
              tip="Crops audio from the end of the file. You can also drag the red OUT handle directly on the waveform."
            />
            <div className="sfx-rack-control-inline">
              <DsRange
                aria-label="Trim End (ms)"
                min={0}
                max={Math.max(100, Math.floor(rawMs - shaper.trimStartMs - 20))}
                step={5}
                value={shaper.trimEndMs}
                onChange={(e) =>
                  setShaper((s) => ({
                    ...s,
                    trimEndMs: Math.max(0, Number(e.target.value)),
                  }))
                }
              />
              <input
                aria-label="Trim End (ms) value"
                type="number"
                min={0}
                max={Math.floor(rawMs)}
                step={10}
                value={shaper.trimEndMs}
                onChange={(e) =>
                  setShaper((s) => ({
                    ...s,
                    trimEndMs: Math.max(0, Number(e.target.value) || 0),
                  }))
                }
                className="sfx-num-input ds-tnum"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Column 2: Boundary Fades */}
      <section className="sfx-rack-card">
        <div className="sfx-rack-card-head">
          <span className="ds-panel-title">Fade In &amp; Fade Out</span>
        </div>
        <div className="sfx-rack-fields">
          <div className="sfx-rack-row">
            <LabelWithTip
              label="Fade-In (ms)"
              tip="Smoothly ramps volume up from silence at the start of the cropped region (shown in amber on the waveform)."
            />
            <div className="sfx-rack-control-inline">
              <DsRange
                aria-label="Fade-In (ms)"
                min={0}
                max={fadeMax}
                step={5}
                value={shaper.fadeInMs}
                onChange={(e) =>
                  setShaper((s) => ({ ...s, fadeInMs: Number(e.target.value) }))
                }
              />
              <input
                aria-label="Fade-In (ms) value"
                type="number"
                min={0}
                max={10000}
                step={10}
                value={shaper.fadeInMs}
                onChange={(e) =>
                  setShaper((s) => ({
                    ...s,
                    fadeInMs: Math.max(0, Number(e.target.value) || 0),
                  }))
                }
                className="sfx-num-input ds-tnum"
              />
            </div>
          </div>

          <div className="sfx-rack-row">
            <LabelWithTip
              label="Fade-Out (ms)"
              tip="Smoothly ramps volume down to silence at the end of the cropped region (shown in amber on the waveform)."
            />
            <div className="sfx-rack-control-inline">
              <DsRange
                aria-label="Fade-Out (ms)"
                min={0}
                max={fadeMax}
                step={5}
                value={shaper.fadeOutMs}
                onChange={(e) =>
                  setShaper((s) => ({ ...s, fadeOutMs: Number(e.target.value) }))
                }
              />
              <input
                aria-label="Fade-Out (ms) value"
                type="number"
                min={0}
                max={10000}
                step={10}
                value={shaper.fadeOutMs}
                onChange={(e) =>
                  setShaper((s) => ({
                    ...s,
                    fadeOutMs: Math.max(0, Number(e.target.value) || 0),
                  }))
                }
                className="sfx-num-input ds-tnum"
              />
            </div>
          </div>

          <div className="sfx-rack-row">
            <LabelWithTip
              label="Fade Curve"
              tip="Shape of the fade-in and fade-out slopes."
            />
            <div className="sfx-pill-group" role="group" aria-label="Fade Curve">
              {(
                [
                  ["cosine", "S-Curve"],
                  ["equal-power", "Fast Attack"],
                  ["linear", "Linear"],
                ] as const
              ).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setShaper((s) => ({ ...s, fadeCurve: val }))}
                  className={`sfx-choice-pill ${
                    shaper.fadeCurve === val ? "active" : ""
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Column 3: Gain, Normalization & Polarity */}
      <section className="sfx-rack-card">
        <div className="sfx-rack-card-head">
          <span className="ds-panel-title">Gain &amp; Normalization</span>
        </div>
        <div className="sfx-rack-fields">
          <div className="sfx-rack-row">
            <LabelWithTip
              label="Output Gain (dB)"
              tip="Boost or attenuate overall volume in decibels."
            />
            <div className="sfx-rack-control-inline">
              <DsRange
                aria-label="Output Gain (dB)"
                min={-24}
                max={24}
                step={0.5}
                value={shaper.gainDb}
                onChange={(e) =>
                  setShaper((s) => ({ ...s, gainDb: Number(e.target.value) }))
                }
              />
              <span className="sfx-val-readout ds-tnum">
                {shaper.gainDb >= 0
                  ? `+${shaper.gainDb.toFixed(1)}`
                  : shaper.gainDb.toFixed(1)}{" "}
                dB
              </span>
            </div>
          </div>

          <div className="sfx-rack-row">
            <LabelWithTip
              label="Peak Normalize"
              tip="Automatically scales the sound so its loudest peak hits the exact target ceiling."
            />
            <div className="sfx-pill-group" role="group" aria-label="Peak Normalize">
              {(
                [
                  [null, "Off"],
                  [-0.1, "-0.1 dB"],
                  [-1.0, "-1.0 dB"],
                  [-3.0, "-3.0 dB"],
                  [-6.0, "-6.0 dB"],
                ] as const
              ).map(([val, label]) => (
                <button
                  key={String(val)}
                  type="button"
                  onClick={() =>
                    setShaper((s) => ({ ...s, normalizePeakDbfs: val }))
                  }
                  className={`sfx-choice-pill ${
                    shaper.normalizePeakDbfs === val ? "active" : ""
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="sfx-rack-row">
            <LabelWithTip
              label="Phase &amp; Direction"
              tip="Reverse plays the cropped region backwards; Remove DC Offset centers the waveform on zero."
            />
            <div className="sfx-pill-group" role="group" aria-label="Phase & Direction">
              <button
                type="button"
                onClick={() => setShaper((s) => ({ ...s, reverse: !s.reverse }))}
                className={`sfx-choice-pill ${shaper.reverse ? "active" : ""}`}
              >
                Reverse Audio
              </button>
              <button
                type="button"
                onClick={() =>
                  setShaper((s) => ({ ...s, dcOffsetRemove: !s.dcOffsetRemove }))
                }
                className={`sfx-choice-pill ${
                  shaper.dcOffsetRemove ? "active" : ""
                }`}
              >
                Remove DC Offset
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
