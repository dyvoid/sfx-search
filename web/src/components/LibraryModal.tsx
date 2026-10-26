import React, { useEffect, useRef, useState } from "react";
import { Folder, RefreshCw, Trash2, X } from "lucide-react";
import { IndexingProgress, LibraryStats } from "../types";
import { AddFolderControl } from "./AddFolderControl";

interface LibraryModalProps {
  open: boolean;
  roots: string[];
  stats: LibraryStats | null;
  indexing: IndexingProgress | null;
  onClose: () => void;
  onAddRoot: (path: string) => Promise<void>;
  onBrowseRoot: () => Promise<void>;
  onRemoveRoot: (path: string) => Promise<void>;
  onRescan: (reindex: boolean) => Promise<void>;
}

export const LibraryModal: React.FC<LibraryModalProps> = ({
  open,
  roots,
  stats,
  indexing,
  onClose,
  onAddRoot,
  onBrowseRoot,
  onRemoveRoot,
  onRescan,
}) => {
  // Two-step confirm for destructive actions: first click arms for 3s.
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) {
      return;
    }
    const timer = window.setTimeout(() => setArmed(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const dlgRef = useRef<HTMLDivElement | null>(null);

  // Focus management: move focus in on open, trap Tab, restore on close.
  useEffect(() => {
    if (!open) {
      return;
    }
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusables = (): HTMLElement[] =>
      Array.from(
        dlgRef.current?.querySelectorAll<HTMLElement>(
          "input, button, select, textarea, a[href], [tabindex]:not([tabindex='-1'])"
        ) ?? []
      ).filter((el) => !(el as HTMLButtonElement).disabled);
    (focusables()[0] ?? dlgRef.current)?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !dlgRef.current) {
        return;
      }
      const f = focusables();
      if (f.length === 0) {
        e.preventDefault();
        dlgRef.current.focus();
        return;
      }
      const first = f[0];
      const last = f[f.length - 1];
      const active = document.activeElement;
      if (!dlgRef.current.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === dlgRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener && opener.isConnected) {
        opener.focus();
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const isRunning = indexing?.state === "running";
  const doneCount = (indexing?.indexed_ok || 0) + (indexing?.indexed_errors || 0);
  const totalCount = indexing?.to_index_count || 0;
  const pct =
    totalCount > 0 ? Math.min(100, Math.round((doneCount / totalCount) * 100)) : 0;

  const confirmThen = (key: string, action: () => void) => () => {
    if (armed === key) {
      setArmed(null);
      action();
    } else {
      setArmed(key);
    }
  };

  return (
    <div
      className="ds-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dlgRef}
        tabIndex={-1}
        className="ds-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lib-dialog-title"
        style={{ width: 620, maxWidth: "92vw" }}
      >
        <div
          className="ds-dialog-head"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span id="lib-dialog-title">Library folders</span>
          <button
            type="button"
            onClick={onClose}
            className="sfx-icon-btn"
            aria-label="Close dialog"
          >
            <X size={16} />
          </button>
        </div>

        <div
          className="ds-dialog-body"
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}
        >
          {roots.length === 0 ? (
            <p className="sfx-folders-empty">
              No folders yet. Add the folders that hold your sound effects;
              they are scanned in the background.
            </p>
          ) : (
            <ul className="sfx-folder-list">
              {roots.map((rt) => (
                <li key={rt} className="sfx-folder-item">
                  <Folder size={14} className="sfx-folder-item-icon" />
                  <span className="sfx-folder-item-path">{rt}</span>
                  <button
                    type="button"
                    disabled={isRunning}
                    onClick={confirmThen(`rm:${rt}`, () => {
                      void onRemoveRoot(rt);
                    })}
                    className={`ds-btn ds-btn-sm ${
                      armed === `rm:${rt}` ? "ds-btn-danger" : "ds-btn-ghost"
                    }`}
                    style={
                      armed === `rm:${rt}`
                        ? undefined
                        : { color: "var(--danger-400)" }
                    }
                  >
                    <Trash2 size={14} />
                    {armed === `rm:${rt}` ? "Confirm remove" : "Remove"}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <AddFolderControl
            onBrowse={onBrowseRoot}
            onAddPath={onAddRoot}
            primary={roots.length === 0}
          />

          {/* Live Indexer Status */}
          {isRunning && indexing && (
            <div
              style={{
                padding: "var(--space-3) var(--space-4)",
                borderTop: "var(--border-width) solid var(--border-subtle)",
              }}
            >
              <div className="ds-progress-row">
                <div className="ds-progress-label">
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      color: "var(--text-primary)",
                    }}
                  >
                    <span
                      className="ds-spinner"
                      style={{ width: 12, height: 12 }}
                    />
                    Scanning & embedding in background ({doneCount} /{" "}
                    {totalCount || "?"} files)
                  </span>
                  <span className="ds-progress-pct ds-tnum">
                    {indexing.files_per_min.toFixed(0)} files/min · {pct}%
                  </span>
                </div>
                <div className="ds-progress-track">
                  <div
                    className="ds-progress-fill"
                    style={{ width: `${Math.max(4, pct)}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {indexing?.state === "error" && indexing.error && (
            <div className="ds-toast">
              <span className="ds-toast-dot danger" />
              <div className="ds-toast-body">
                <div className="ds-toast-title">Indexer error</div>
                <div className="ds-toast-msg">{indexing.error}</div>
              </div>
            </div>
          )}
        </div>

        <div className="ds-dialog-foot">
          {stats && roots.length > 0 && (
            <span className="sfx-folders-summary ds-tnum">
              {stats.ok_files.toLocaleString()} files indexed
            </span>
          )}
          {roots.length > 0 && (
            <>
              <button
                type="button"
                disabled={isRunning}
                onClick={() => onRescan(false)}
                className="ds-btn ds-btn-secondary"
              >
                <RefreshCw size={14} />
                Scan for changes
              </button>
              <button
                type="button"
                disabled={isRunning}
                onClick={confirmThen("rebuild", () => {
                  void onRescan(true);
                })}
                className={`ds-btn ${
                  armed === "rebuild" ? "ds-btn-danger" : "ds-btn-ghost"
                }`}
              >
                {armed === "rebuild" ? "Confirm rebuild" : "Rebuild all"}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ds-btn ds-btn-primary"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
