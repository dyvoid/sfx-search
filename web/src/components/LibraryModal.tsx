import React, { useEffect, useRef, useState } from "react";
import {
  Folder,
  FolderPlus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { IndexingProgress, LibraryStats } from "../types";

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
  const [pathInput, setPathInput] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = pathInput.trim();
    if (!clean) {
      return;
    }
    setBusy(true);
    setErrorMsg("");
    try {
      await onAddRoot(clean);
      setPathInput("");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to add folder");
    } finally {
      setBusy(false);
    }
  };

  const handleBrowse = async () => {
    setBusy(true);
    setErrorMsg("");
    try {
      await onBrowseRoot();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Failed to pick folder"
      );
    } finally {
      setBusy(false);
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
          {/* Add folder form */}
          <form onSubmit={handleSubmit} className="ds-input-field">
            <label className="ds-input-label">
              Add folder to scan in the background
            </label>
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <div
                className={`ds-input-box ${errorMsg ? "error" : ""}`}
                style={{ flex: 1 }}
              >
                <input
                  type="text"
                  value={pathInput}
                  onChange={(e) => {
                    setPathInput(e.target.value);
                    setErrorMsg("");
                  }}
                  placeholder="D:/SFX or C:/Audio/Foley"
                  className="ds-input"
                  style={{ fontFamily: "var(--font-mono)" }}
                />
              </div>
              <button
                type="submit"
                disabled={busy || !pathInput.trim()}
                className="ds-btn ds-btn-primary"
              >
                <FolderPlus size={14} />
                Add folder
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleBrowse}
                className="ds-btn ds-btn-secondary"
              >
                <Folder size={14} />
                Browse
              </button>
            </div>
            {errorMsg && <span className="ds-input-error">{errorMsg}</span>}
          </form>

          {/* Configured roots table */}
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "var(--space-2)",
              }}
            >
              <span className="ds-microlabel">
                Configured folders ({roots.length})
              </span>
              {stats && (
                <span
                  className="ds-tnum"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--text-tertiary)",
                  }}
                >
                  {stats.ok_files.toLocaleString()} files indexed
                </span>
              )}
            </div>

            {roots.length === 0 ? (
              <div
                style={{
                  padding: "var(--space-6)",
                  border: "var(--border-width) dashed var(--border-strong)",
                  borderRadius: "var(--radius-sm)",
                  textAlign: "center",
                  color: "var(--text-tertiary)",
                  fontSize: "var(--font-size-sm)",
                }}
              >
                No library folders configured yet. Add a folder above to start
                scanning.
              </div>
            ) : (
              <div className="ds-table-wrap">
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th>Folder path</th>
                      <th style={{ width: 90, textAlign: "right" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roots.map((rt) => (
                      <tr key={rt}>
                        <td
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "var(--font-size-xs)",
                            wordBreak: "break-all",
                          }}
                        >
                          {rt}
                        </td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <button
                            type="button"
                            disabled={isRunning}
                            onClick={confirmThen(`rm:${rt}`, () => {
                              void onRemoveRoot(rt);
                            })}
                            className={`ds-btn ds-btn-sm ${
                              armed === `rm:${rt}`
                                ? "ds-btn-danger"
                                : "ds-btn-ghost"
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
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

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
