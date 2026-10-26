import React from "react";

export interface KeyHint {
  /** What to press or do, shown as a key cap ("Space", "Ctrl+S", "Drag"). */
  keys: string;
  /** What it does, in plain words. */
  label: string;
}

/** Footer shortcut hints: a key cap plus a plain word per action. */
export const KeyHints: React.FC<{ hints: KeyHint[] }> = ({ hints }) => (
  <span className="sfx-statusbar-shortcuts">
    {hints.map((h) => (
      <span key={`${h.keys} ${h.label}`} className="sfx-key-hint">
        <kbd className="sfx-kbd">{h.keys}</kbd>
        {h.label}
      </span>
    ))}
  </span>
);
