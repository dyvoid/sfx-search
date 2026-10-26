import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export interface DsSelectOption {
  value: string;
  label: string;
  hint?: string;
}

interface DsSelectProps {
  value: string;
  options: DsSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  width?: number | string;
  height?: number | string;
  ariaLabel?: string;
}

export const DsSelect: React.FC<DsSelectProps> = ({
  value,
  options,
  onChange,
  disabled = false,
  width = 160,
  height,
  ariaLabel,
}) => {
  const [open, setOpen] = useState<boolean>(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const selectedOption =
    options.find((o) => o.value === value) || options[0] || { value: "", label: "" };

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation(); // an open dropdown owns Escape; keep it from the app
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // Move focus into the list on open so the arrow keys drive the options.
  useEffect(() => {
    if (!open) {
      return;
    }
    const opts = wrapRef.current?.querySelectorAll<HTMLElement>("[role='option']");
    (wrapRef.current?.querySelector<HTMLElement>(".ds-select-option.sel") ??
      opts?.[0])?.focus();
  }, [open]);

  const handleKeyNav = (e: React.KeyboardEvent) => {
    if (!open) {
      return;
    }
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const opts = Array.from(
      wrapRef.current?.querySelectorAll<HTMLElement>("[role='option']") ?? []
    );
    if (opts.length === 0) {
      return;
    }
    const cur = opts.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
        ? opts.length - 1
        : e.key === "ArrowDown"
        ? Math.min(opts.length - 1, cur + 1)
        : Math.max(0, cur - 1);
    opts[next].focus();
  };

  return (
    <div
      ref={wrapRef}
      onKeyDown={handleKeyNav}
      style={{
        position: "relative",
        width,
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
        pointerEvents: disabled ? "none" : "auto",
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
        className={`ds-select-field ${open ? "open" : ""}`}
        style={{ width: "100%", height: height || undefined }}
      >
        <span
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {selectedOption.label}
        </span>
        <ChevronDown className="ds-select-chev" size={14} />
      </button>

      {open && (
        <div
          role="listbox"
          className="ds-select-pop"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            minWidth: "100%",
            top: "100%",
            zIndex: 60,
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {options.map((opt) => {
            const isSel = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSel}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className={`ds-select-option ${isSel ? "sel" : ""}`}
              >
                <span
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {opt.label}
                </span>
                {opt.hint && <span className="ds-select-hint">{opt.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
