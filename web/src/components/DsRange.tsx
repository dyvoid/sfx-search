import React from "react";

type DsRangeProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
>;

/**
 * dyvoided slider: the real ds-slider-track/fill/knob structure with the
 * native <input type="range"> overlaid transparent, per the kit's Slider
 * reference. `data-ds-track` lets tokens/interaction.css ring the track
 * on keyboard focus.
 */
export const DsRange: React.FC<DsRangeProps> = ({
  className,
  style,
  ...props
}) => {
  const min = Number(props.min ?? 0);
  const max = Number(props.max ?? 100);
  const raw = Number(props.value ?? props.defaultValue ?? min);
  const pct =
    max > min
      ? Math.min(100, Math.max(0, ((raw - min) / (max - min)) * 100))
      : 0;

  return (
    <span
      data-ds-track=""
      className={
        className
          ? `ds-slider-track sfx-range-input ${className}`
          : "ds-slider-track sfx-range-input"
      }
      style={{ display: "block", ...style }}
    >
      <span className="ds-slider-fill" style={{ width: `${pct}%` }} />
      <span
        className="ds-slider-knob"
        style={{ left: `calc(${pct}% - 7px)` }}
      />
      <input type="range" {...props} />
    </span>
  );
};
