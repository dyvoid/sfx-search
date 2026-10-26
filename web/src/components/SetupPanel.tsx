import React from "react";
import { AlertTriangle, FolderOpen, FolderPlus } from "lucide-react";
import { AddFolderControl } from "./AddFolderControl";
import { IndexingProgress } from "../types";

interface SetupPanelProps {
  roots: string[];
  indexing: IndexingProgress | null;
  onBrowse: () => Promise<void>;
  onAddPath: (path: string) => Promise<void>;
  /** Re-run the folder scan after a failure. */
  onRetry: () => void;
}

function formatEta(seconds: number): string {
  if (seconds < 90) {
    return `about ${Math.max(1, Math.round(seconds))} s left`;
  }
  return `about ${Math.round(seconds / 60)} min left`;
}

/**
 * Whole-screen first-run state (no indexed files yet). Renders exactly one of:
 * no folders, scanning, scan failed, or folders without audio.
 */
export const SetupPanel: React.FC<SetupPanelProps> = ({
  roots,
  indexing,
  onBrowse,
  onAddPath,
  onRetry,
}) => {
  const scanning = roots.length > 0 && indexing?.state === "running";
  const failed = roots.length > 0 && indexing?.state === "error";

  const folderList = roots.length > 0 && (
    <div className="sfx-setup-folders">
      <div className="ds-microlabel">Active folders</div>
      <div className="sfx-setup-folder-list">
        {roots.map((r) => (
          <span key={r} className="sfx-setup-folder">
            {r}
          </span>
        ))}
      </div>
    </div>
  );

  if (roots.length === 0) {
    return (
      <div className="sfx-setup">
        <div className="sfx-setup-head">
          <FolderPlus size={18} className="sfx-setup-icon" />
          <h2 className="ds-empty-title">Add your sound-effects folders</h2>
        </div>
        <p className="sfx-setup-text">
          Choose the folders that hold your sound library. Search is ready as
          soon as the first sounds have been scanned.
        </p>
        <AddFolderControl onBrowse={onBrowse} onAddPath={onAddPath} primary />
      </div>
    );
  }

  if (scanning && indexing) {
    const done = indexing.indexed_ok + indexing.indexed_errors;
    const total = indexing.to_index_count;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return (
      <div className="sfx-setup">
        <div className="sfx-setup-head">
          <span className="ds-spinner" />
          <h2 className="ds-empty-title">Scanning your folders</h2>
        </div>
        <p className="sfx-setup-text">
          Search is ready as soon as the first sounds have been scanned.
        </p>
        <div className="ds-progress-row" role="status">
          <div className="ds-progress-label">
            <span className="ds-tnum" style={{ color: "var(--text-primary)" }}>
              {total > 0
                ? `${done.toLocaleString()} of ${total.toLocaleString()} files`
                : "Looking for audio files…"}
            </span>
            {total > 0 && (
              <span className="ds-progress-pct ds-tnum">
                {indexing.files_per_min > 0 && indexing.eta_seconds > 0
                  ? `${formatEta(indexing.eta_seconds)} · `
                  : ""}
                {pct}%
              </span>
            )}
          </div>
          <div
            className="ds-progress-track"
            role="progressbar"
            aria-label="Scan progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div
              className="ds-progress-fill"
              style={{ width: `${Math.max(3, pct)}%` }}
            />
          </div>
        </div>
        {folderList}
        <AddFolderControl
          onBrowse={onBrowse}
          onAddPath={onAddPath}
          primary={false}
        />
      </div>
    );
  }

  if (failed && indexing) {
    const message = (indexing.error || "").trim();
    const [first, ...rest] = message.split(/\r?\n/);
    const details = rest.join("\n").trim();
    return (
      <div className="sfx-setup">
        <div className="sfx-setup-head">
          <AlertTriangle size={18} className="sfx-setup-icon danger" />
          <h2 className="ds-empty-title">Scanning stopped</h2>
        </div>
        <p className="sfx-setup-text sfx-setup-error" role="alert">
          {first || "Something went wrong while scanning your folders."}
        </p>
        {details && (
          <details className="sfx-setup-details">
            <summary>Details</summary>
            <pre>{details}</pre>
          </details>
        )}
        <div>
          <button type="button" className="ds-btn ds-btn-primary" onClick={onRetry}>
            Try again
          </button>
        </div>
        {folderList}
      </div>
    );
  }

  return (
    <div className="sfx-setup">
      <div className="sfx-setup-head">
        <FolderOpen size={18} className="sfx-setup-icon" />
        <h2 className="ds-empty-title">No audio files found</h2>
      </div>
      <p className="sfx-setup-text">
        {roots.length === 1
          ? "This folder has no audio files yet."
          : "These folders have no audio files yet."}
      </p>
      {folderList}
      <AddFolderControl onBrowse={onBrowse} onAddPath={onAddPath} primary />
    </div>
  );
};
