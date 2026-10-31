import React from "react";
import { DsRange } from "../../components/DsRange";
import { DEFAULT_EQ_SPEC, EqSpec } from "../audio/dspChain";
import { EqResponseGraph } from "../SeamScope";

interface ToneEqPanelsProps {
  eq: EqSpec;
  setEq: React.Dispatch<React.SetStateAction<EqSpec>>;
  sampleRate: number;
}

const signedDb = (v: number): string => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1));

/** Tone & EQ module of the edit page: cut filters, 3-band tone, response curve. */
export const ToneEqPanels: React.FC<ToneEqPanelsProps> = ({ eq, setEq, sampleRate }) => (
  <div className="sfx-rack-grid">
    <section className="sfx-rack-card">
      <div className="sfx-rack-card-head">
        <span className="ds-panel-title">High / Low Cut Filters</span>
      </div>
      <div className="sfx-rack-fields">
        <div className="sfx-rack-row">
          <label className="sfx-rack-label">High-Pass (Hz)</label>
          <div className="sfx-rack-control-inline">
            <DsRange
              aria-label="High-Pass (Hz)"
              min={20}
              max={1200}
              step={5}
              value={eq.highpassHz}
              onChange={(e) => setEq((s) => ({ ...s, highpassHz: Number(e.target.value) }))}
            />
            <span className="sfx-val-readout ds-tnum">
              {eq.highpassHz <= 22 ? "Off" : `${eq.highpassHz} Hz`}
            </span>
          </div>
        </div>

        <div className="sfx-rack-row">
          <label className="sfx-rack-label">Low-Pass (Hz)</label>
          <div className="sfx-rack-control-inline">
            <DsRange
              aria-label="Low-Pass (Hz)"
              min={400}
              max={20000}
              step={100}
              value={eq.lowpassHz}
              onChange={(e) => setEq((s) => ({ ...s, lowpassHz: Number(e.target.value) }))}
            />
            <span className="sfx-val-readout ds-tnum">
              {eq.lowpassHz >= 19500 ? "Off" : `${(eq.lowpassHz / 1000).toFixed(1)} kHz`}
            </span>
          </div>
        </div>

        <div className="sfx-rack-row">
          <label className="sfx-rack-label">Quick Presets</label>
          <div className="sfx-pill-group" role="group" aria-label="Quick Presets">
            <button
              type="button"
              onClick={() => setEq(DEFAULT_EQ_SPEC)}
              className="sfx-choice-pill"
            >
              Flat
            </button>
            <button
              type="button"
              onClick={() => setEq({ ...DEFAULT_EQ_SPEC, highpassHz: 110, lowGainDb: -3 })}
              className="sfx-choice-pill"
            >
              De-Rumble
            </button>
            <button
              type="button"
              onClick={() =>
                setEq({ ...DEFAULT_EQ_SPEC, highpassHz: 60, lowpassHz: 2400, highGainDb: -6 })
              }
              className="sfx-choice-pill"
            >
              Warm Ambience
            </button>
            <button
              type="button"
              onClick={() =>
                setEq({
                  ...DEFAULT_EQ_SPEC,
                  highpassHz: 420,
                  lowpassHz: 3400,
                  midGainDb: 6,
                  midFreqHz: 1400,
                  midQ: 1.8,
                })
              }
              className="sfx-choice-pill"
            >
              Radio Comms
            </button>
          </div>
        </div>
      </div>
    </section>

    <section className="sfx-rack-card">
      <div className="sfx-rack-card-head">
        <span className="ds-panel-title">3-Band Tone</span>
      </div>
      <div className="sfx-rack-fields">
        <div className="sfx-rack-row">
          <label className="sfx-rack-label">Low Shelf (120Hz)</label>
          <div className="sfx-rack-control-inline">
            <DsRange
              aria-label="Low Shelf (120Hz)"
              min={-15}
              max={15}
              step={0.5}
              value={eq.lowGainDb}
              onChange={(e) => setEq((s) => ({ ...s, lowGainDb: Number(e.target.value) }))}
            />
            <span className="sfx-val-readout ds-tnum">{signedDb(eq.lowGainDb)} dB</span>
          </div>
        </div>

        <div className="sfx-rack-row">
          <label className="sfx-rack-label">Mid Peak ({eq.midFreqHz}Hz)</label>
          <div className="sfx-rack-control-inline">
            <DsRange
              aria-label={`Mid Peak (${eq.midFreqHz}Hz)`}
              min={-15}
              max={15}
              step={0.5}
              value={eq.midGainDb}
              onChange={(e) => setEq((s) => ({ ...s, midGainDb: Number(e.target.value) }))}
            />
            <span className="sfx-val-readout ds-tnum">{signedDb(eq.midGainDb)} dB</span>
          </div>
        </div>

        <div className="sfx-rack-row">
          <label className="sfx-rack-label">High Shelf (4.5k)</label>
          <div className="sfx-rack-control-inline">
            <DsRange
              aria-label="High Shelf (4.5k)"
              min={-15}
              max={15}
              step={0.5}
              value={eq.highGainDb}
              onChange={(e) => setEq((s) => ({ ...s, highGainDb: Number(e.target.value) }))}
            />
            <span className="sfx-val-readout ds-tnum">{signedDb(eq.highGainDb)} dB</span>
          </div>
        </div>
      </div>
    </section>

    <section className="sfx-rack-card">
      <div className="sfx-rack-card-head">
        <span className="ds-panel-title">EQ Frequency Response</span>
        <span className="sfx-rack-hint">20 Hz – 20 kHz</span>
      </div>
      <EqResponseGraph spec={eq} sampleRate={sampleRate} />
    </section>
  </div>
);
