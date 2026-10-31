import React from "react";
import { CircleHelp } from "lucide-react";

export const LabelWithTip: React.FC<{ label: string; tip: string }> = ({
  label,
  tip,
}) => (
  <span className="sfx-rack-label sfx-label-with-tip">
    <span>{label}</span>
    <span className="sfx-tip-wrap" tabIndex={0} aria-label={tip}>
      <CircleHelp size={11} className="sfx-tip-icon" />
      <span className="sfx-tip-bubble">{tip}</span>
    </span>
  </span>
);
