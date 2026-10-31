import React from "react";
import { DsRange } from "../../components/DsRange";
import { VariationSpec } from "../audio/variations";
import { LabelWithTip } from "./LabelWithTip";

interface VariationControlsProps {
  varSpec: VariationSpec;
  setVarSpec: React.Dispatch<React.SetStateAction<VariationSpec>>;
  onReset: () => void;
}

interface CheckProps {
  checked: boolean;
  label: string;
  onToggle: () => void;
}

const Check: React.FC<CheckProps> = ({ checked, label, onToggle }) => (
  <label
    role="checkbox"
    aria-checked={checked}
    tabIndex={0}
    className="ds-check"
    onKeyDown={(e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        e.currentTarget.click();
      }
    }}
    onClick={onToggle}
  >
    <div className={`ds-checkbox ${checked ? "on" : ""}`}>
      {checked && <div className="ds-checkbox-inner" />}
    </div>
    <span className="ds-check-label" style={{ fontSize: "var(--font-size-xs)" }}>
      {label}
    </span>
  </label>
);

interface PercentRowProps {
  label: string;
  tip: string;
  value: number;
  max: number;
  readout: string;
  onChange: (v: number) => void;
  min?: number;
}

const SliderRow: React.FC<PercentRowProps> = ({
  label,
  tip,
  value,
  max,
  readout,
  onChange,
  min = 0,
}) => (
  <div className="sfx-rack-row">
    <LabelWithTip label={label} tip={tip} />
    <div className="sfx-rack-control-inline">
      <DsRange
        aria-label={label}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="sfx-val-readout ds-tnum">{readout}</span>
    </div>
  </div>
);

/** Variations page: the two cards that shape how takes differ. */
export const VariationControls: React.FC<VariationControlsProps> = ({
  varSpec,
  setVarSpec,
  onReset,
}) => {
  const set = <K extends keyof VariationSpec>(key: K) => (v: VariationSpec[K]) =>
    setVarSpec((s) => ({ ...s, [key]: v }));
  return (
    <>
      {/* Pitch, Drift & Volume */}
      <section className="sfx-rack-card">
        <div className="sfx-rack-card-head">
          <span className="ds-panel-title">Pitch &amp; Movement</span>
          <div className="sfx-pill-group" role="group" aria-label="Variation mode">
            {(
              [
                ["foley", "Foley"],
                ["melodic", "Melodic"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => set("mode")(m)}
                className={`sfx-choice-pill ${varSpec.mode === m ? "active" : ""}`}
                title={
                  m === "foley"
                    ? "Foley mode: continuous pitch shifts and organic internal movement"
                    : "Melodic mode: keeps takes in key at low settings, or snaps to musical scale steps at high settings"
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="sfx-rack-fields">
          <SliderRow
            label="Pitch Shift"
            tip="Shifts the overall pitch of each take up or down (evenly spread across your takes so no two sound identical). Great for footsteps, impacts, and weapons."
            value={varSpec.pitchShift}
            max={100}
            readout={`${varSpec.pitchShift}%`}
            onChange={set("pitchShift")}
          />
          <SliderRow
            label="Pitch Drift"
            tip="Bends pitch and speed dynamically over time along a smooth curve (amber line) without changing the total length of the sound. Ideal for whooshes, creaks, vocals, and textures."
            value={varSpec.driftAmount}
            max={100}
            readout={`${varSpec.driftAmount}%`}
            onChange={set("driftAmount")}
          />
          <SliderRow
            label="Volume Swell"
            tip="Varies the loudness contour over time (teal line) as well as the overall hit strength of each take."
            value={varSpec.volumeAmount}
            max={100}
            readout={`${varSpec.volumeAmount}%`}
            onChange={set("volumeAmount")}
          />
          <SliderRow
            label="Curve Complexity"
            tip="Number of random inflection points along the Pitch Drift and Volume Swell curves (2 = slow gentle bend, 16 = fast wobbly movement)."
            value={varSpec.controlPoints}
            min={2}
            max={16}
            readout={`${varSpec.controlPoints} pts`}
            onChange={set("controlPoints")}
          />
          <div className="sfx-rack-row">
            <Check
              checked={varSpec.linkPitchAndVolume}
              label="Link pitch & volume movement"
              onToggle={() => set("linkPitchAndVolume")(!varSpec.linkPitchAndVolume)}
            />
          </div>
        </div>
      </section>

      {/* Tone, Protection & Character */}
      <section className="sfx-rack-card">
        <div className="sfx-rack-card-head">
          <span className="ds-panel-title">Tone, Timing &amp; Protection</span>
          <button
            type="button"
            onClick={onReset}
            className="ds-btn ds-btn-ghost ds-btn-sm"
            title="Put every variation setting back to its default"
          >
            Reset
          </button>
        </div>

        <div className="sfx-rack-fields">
          <SliderRow
            label="Tone Variation"
            tip="Controls how much EQ color (brightness, warmth, and resonant body) varies per take. Harder hits are naturally brighter; set to 0% for zero EQ change."
            value={varSpec.toneSpread}
            max={100}
            readout={`${varSpec.toneSpread}%`}
            onChange={set("toneSpread")}
          />
          <SliderRow
            label="Attack Punch"
            tip="Subtly varies the crispness and snap of the first 30ms of each take so rapid-fire footsteps or weapon hits never sound robotic ('machine-gun effect')."
            value={varSpec.attackSnap}
            max={100}
            readout={`${varSpec.attackSnap}%`}
            onChange={set("attackSnap")}
          />
          <SliderRow
            label="Length Variation"
            tip="How much shorter or longer each take may be. The pitch does not change. Set to 0% when variations must stay locked to an exact animation length."
            value={varSpec.lengthSpreadPct}
            max={25}
            readout={`±${varSpec.lengthSpreadPct}%`}
            onChange={set("lengthSpreadPct")}
          />

          <div className="sfx-rack-row">
            <LabelWithTip
              label="Protect Start / End"
              tip="Fades the internal Pitch Drift and Volume Swell in at the start and out at the end so your initial impact stays untouched and your tail/loop end stays anchored."
            />
            <div className="sfx-rack-control-inline">
              <DsRange
                aria-label="Protect Start"
                min={0}
                max={45}
                step={1}
                value={varSpec.protectStartPct}
                onChange={(e) => set("protectStartPct")(Number(e.target.value))}
                title={`Protect Start: ${varSpec.protectStartPct}%`}
              />
              <DsRange
                aria-label="Protect End"
                min={0}
                max={45}
                step={1}
                value={varSpec.protectEndPct}
                onChange={(e) => set("protectEndPct")(Number(e.target.value))}
                title={`Protect End: ${varSpec.protectEndPct}%`}
              />
              <span className="sfx-val-readout ds-tnum">
                {varSpec.protectStartPct}% / {varSpec.protectEndPct}%
              </span>
            </div>
          </div>

          <div className="sfx-rack-row">
            <Check
              checked={varSpec.preserveFormants}
              label="Preserve natural body when pitching (Formants)"
              onToggle={() => set("preserveFormants")(!varSpec.preserveFormants)}
            />
          </div>
        </div>
      </section>
    </>
  );
};
