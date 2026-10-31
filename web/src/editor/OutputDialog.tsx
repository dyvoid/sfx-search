import React, { useState } from "react";
import { Check, X } from "lucide-react";
import { FolderTree } from "../components/FolderTree";
import { FolderEntry } from "../types";
import {
  BIT_DEPTHS,
  BITRATES,
  extensionOf,
  FORMAT_CHOICES,
  OutputSpec,
  stripExtension,
} from "./audio/outputFormat";

interface OutputDialogProps {
  /** Save into the library, or download to the browser's downloads folder. */
  mode: "save" | "download";
  /** One file with an editable name, or several takes with fixed names. */
  takeStems: string[] | null;
  fileName: string;
  setFileName: (name: string) => void;
  /** What the output contains, one line each ("Trim 0.80–5.10 s", ...). */
  included: string[];
  outputSpec: OutputSpec;
  setOutputSpec: (spec: OutputSpec) => void;
  folder: string;
  setFolder: (folder: string) => void;
  folders: FolderEntry[];
  roots: string[];
  overwrite: boolean;
  setOverwrite: (on: boolean) => void;
  busy: boolean;
  showSpinner: boolean;
  errMsg: string | null;
  onConfirm: () => void;
  onClose: () => void;
  dialogRef: React.RefObject<HTMLDivElement>;
  confirmRef: React.RefObject<HTMLButtonElement>;
}

/** The Save to Library / Download dialog, the same on every Studio page. */
export const OutputDialog: React.FC<OutputDialogProps> = (p) => {
  const toLibrary = p.mode === "save";
  const multi = p.takeStems !== null;
  const count = p.takeStems?.length ?? 1;
  const [pickerOpen, setPickerOpen] = useState<boolean>(toLibrary && !p.folder);
  const [folderFilter, setFolderFilter] = useState<string>("");
  const qualityChoices: { kind: "depth" | "bitrate"; values: number[] } = BIT_DEPTHS[
    p.outputSpec.format
  ]
    ? { kind: "depth", values: BIT_DEPTHS[p.outputSpec.format] ?? [] }
    : { kind: "bitrate", values: BITRATES[p.outputSpec.format] ?? [] };
  const title = multi
    ? toLibrary
      ? "Save takes to library"
      : "Download takes"
    : toLibrary
    ? "Save to library"
    : "Download";
  const nameMissing = !multi && !stripExtension(p.fileName.trim());
  const folderMissing = toLibrary && !p.folder;
  const verb = toLibrary ? "Save" : "Download";
  const confirmLabel = multi ? `${verb} ${count} file${count === 1 ? "" : "s"}` : verb;
  const closeUnlessBusy = () => {
    if (!p.busy) {
      p.onClose();
    }
  };

  return (
    <div
      className="ds-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          closeUnlessBusy();
        }
      }}
    >
      <div
        ref={p.dialogRef}
        aria-busy={p.busy}
        className="ds-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-dialog-title"
        style={{ maxWidth: 400 }}
      >
        <div
          className="ds-dialog-head"
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
        >
          <span id="save-dialog-title">{title}</span>
          <button
            type="button"
            disabled={p.busy}
            onClick={p.onClose}
            className="sfx-icon-btn"
            aria-label="Close dialog"
          >
            <X size={16} />
          </button>
        </div>
        <fieldset
          disabled={p.busy}
          className="ds-dialog-body sfx-dialog-fieldset"
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
        >
          {p.included.length > 0 && (
            <div className="sfx-included">
              <span className="ds-microlabel">Included</span>
              <ul>
                {p.included.map((line) => (
                  <li key={line}>
                    <Check size={12} aria-hidden="true" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {multi ? (
            <ul className="sfx-included-files ds-tnum" aria-label="Files">
              {(p.takeStems ?? []).map((stem) => (
                <li key={stem}>{`${stem}${extensionOf(p.outputSpec)}`}</li>
              ))}
            </ul>
          ) : (
            <>
              <label className="ds-input-label" htmlFor="save-filename">
                Filename
              </label>
              <div className="ds-input-box">
                <input
                  id="save-filename"
                  type="text"
                  autoFocus
                  className="ds-input"
                  style={{ fontFamily: "var(--font-mono)" }}
                  value={p.fileName}
                  onChange={(e) => p.setFileName(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (!e.repeat) {
                        // a held Enter that opened the dialog must not also save
                        p.onConfirm();
                      }
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      closeUnlessBusy();
                    }
                  }}
                  spellCheck={false}
                />
              </div>
            </>
          )}

          {toLibrary && (
            <>
              <span className="ds-input-label">Library folder</span>
              <div className="sfx-folder-choice">
                <span
                  className={`sfx-folder-choice-path ${p.folder ? "" : "empty"}`}
                  title={p.folder || undefined}
                >
                  {/* rtl on the box clips long paths at the start; bdi keeps the path itself ltr */}
                  <bdi>{p.folder || "Choose a folder"}</bdi>
                </span>
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                  aria-expanded={pickerOpen}
                  onClick={() => setPickerOpen((v) => !v)}
                >
                  {pickerOpen ? "Done" : "Change"}
                </button>
              </div>
              {pickerOpen && (
                <div className="sfx-folder-picker">
                  <div className="ds-input-box">
                    <input
                      type="text"
                      className="ds-input"
                      value={folderFilter}
                      onChange={(e) => setFolderFilter(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          closeUnlessBusy();
                        }
                      }}
                      aria-label="Filter library folders"
                      placeholder="Filter folders..."
                      spellCheck={false}
                    />
                  </div>
                  <div className="sfx-folder-picker-tree ds-scroll">
                    <FolderTree
                      folders={p.folders}
                      roots={p.roots}
                      selected={p.folder ? [p.folder] : []}
                      filterText={folderFilter}
                      onToggle={p.setFolder}
                    />
                  </div>
                </div>
              )}
            </>
          )}

          <span className="ds-input-label">Format</span>
          <div className="sfx-pill-group" role="group" aria-label="Format">
            {FORMAT_CHOICES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={p.outputSpec.format === value}
                autoFocus={multi && p.outputSpec.format === value}
                onClick={() => p.setOutputSpec({ ...p.outputSpec, format: value })}
                className={`sfx-choice-pill ${p.outputSpec.format === value ? "active" : ""}`}
              >
                {label}
              </button>
            ))}
          </div>

          {qualityChoices.kind === "depth" ? (
            <>
              <span className="ds-input-label">Bit depth</span>
              <div className="sfx-pill-group" role="group" aria-label="Bit depth">
                {qualityChoices.values.map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={p.outputSpec.bitDepth === d}
                    onClick={() => p.setOutputSpec({ ...p.outputSpec, bitDepth: d })}
                    className={`sfx-choice-pill ds-tnum ${
                      p.outputSpec.bitDepth === d ? "active" : ""
                    }`}
                  >
                    {d === 32 ? "32 float" : `${d}-bit`}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <span className="ds-input-label">Bitrate (kbps)</span>
              <div className="sfx-pill-group" role="group" aria-label="Bitrate">
                {qualityChoices.values.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={p.outputSpec.bitrate === r}
                    onClick={() => p.setOutputSpec({ ...p.outputSpec, bitrate: r })}
                    className={`sfx-choice-pill ds-tnum ${
                      p.outputSpec.bitrate === r ? "active" : ""
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </>
          )}

          {toLibrary && !multi && (
            <label
              role="checkbox"
              aria-checked={p.overwrite}
              aria-disabled={p.busy}
              tabIndex={p.busy ? -1 : 0}
              className="ds-check"
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  if (!e.repeat) {
                    e.currentTarget.click();
                  }
                }
              }}
              onClick={() => {
                if (!p.busy) {
                  p.setOverwrite(!p.overwrite);
                }
              }}
            >
              <div className={`ds-checkbox ${p.overwrite ? "on" : ""}`}>
                {p.overwrite && <div className="ds-checkbox-inner" />}
              </div>
              <span className="ds-check-label" style={{ fontSize: "var(--font-size-xs)" }}>
                Replace file if it already exists
              </span>
            </label>
          )}
          <span className="sfx-rack-hint">
            {toLibrary
              ? "Indexed as soon as it is saved."
              : "Saved to your browser's downloads folder."}
          </span>
          {p.errMsg && (
            <span className="sfx-status-err" role="alert">
              {p.errMsg}
            </span>
          )}
        </fieldset>
        <div className="ds-dialog-foot">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            disabled={p.busy}
            onClick={p.onClose}
          >
            Cancel
          </button>
          {/* aria-disabled, not disabled, while busy: it keeps focus in the dialog */}
          <button
            ref={p.confirmRef}
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            disabled={nameMissing || folderMissing}
            aria-disabled={p.busy}
            onClick={p.onConfirm}
          >
            {p.showSpinner && <span className="ds-spinner sfx-btn-spinner" aria-hidden="true" />}
            {p.showSpinner ? (toLibrary ? "Saving…" : "Encoding…") : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
