import React, { useRef, useState } from "react";
import { FolderPlus } from "lucide-react";

interface AddFolderControlProps {
  /** Opens the native folder picker and adds the picked folder. */
  onBrowse: () => Promise<void>;
  /** Adds a folder from a typed or pasted path. */
  onAddPath: (path: string) => Promise<void>;
  /** Render the picker button as the primary action (e.g. on the empty state). */
  primary?: boolean;
}

/**
 * Adding a library folder: the native picker is the action; a typed/pasted
 * path is a secondary option revealed on demand.
 */
export const AddFolderControl: React.FC<AddFolderControlProps> = ({
  onBrowse,
  onAddPath,
  primary = false,
}) => {
  const [pasteOpen, setPasteOpen] = useState<boolean>(false);
  const [path, setPath] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const pasteToggleRef = useRef<HTMLButtonElement | null>(null);

  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      await action();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add folder");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const closePaste = () => {
    setPasteOpen(false);
    setPath("");
    setError("");
    // The toggle re-mounts on the next render; focus it once it exists.
    window.setTimeout(() => pasteToggleRef.current?.focus(), 0);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = path.trim();
    if (!clean || busy) {
      return;
    }
    if (await run(() => onAddPath(clean))) {
      setPasteOpen(false);
      setPath("");
    }
  };

  return (
    <div className="sfx-add-folder">
      <div className="sfx-add-folder-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(onBrowse)}
          className={`ds-btn ${primary ? "ds-btn-primary" : "ds-btn-secondary"}`}
        >
          <FolderPlus size={14} />
          Add folder…
        </button>
        {!pasteOpen && (
          <button
            ref={pasteToggleRef}
            type="button"
            className="sfx-text-btn"
            onClick={() => {
              setError("");
              setPasteOpen(true);
            }}
          >
            or paste a path
          </button>
        )}
      </div>

      {pasteOpen && (
        <form onSubmit={handleSubmit} className="sfx-add-folder-paste">
          <div
            className={`ds-input-box ${error ? "error" : ""}`}
            style={{ flex: 1 }}
          >
            <input
              type="text"
              autoFocus
              aria-label="Folder path"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setError("");
              }}
              spellCheck={false}
              autoComplete="off"
              className="ds-input"
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </div>
          <button
            type="submit"
            disabled={busy || !path.trim()}
            className="ds-btn ds-btn-secondary"
          >
            Add
          </button>
          <button type="button" onClick={closePaste} className="ds-btn ds-btn-ghost">
            Cancel
          </button>
        </form>
      )}

      {error && (
        <span className="ds-input-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
};
