import React, { useRef, useState } from "react";
import { Library, Upload } from "lucide-react";

interface StudioEmptyProps {
  onOpenFile: (file: File) => void;
  onPickFromLibrary: () => void;
}

/** The Studio tab before any file is loaded. */
export const StudioEmpty: React.FC<StudioEmptyProps> = ({ onOpenFile, onPickFromLibrary }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState<boolean>(false);
  return (
    <div
      className={`sfx-studio-empty ${over ? "over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) {
          onOpenFile(f);
        }
      }}
    >
      <div className="ds-empty">
        <Upload size={28} className="sfx-studio-empty-icon" aria-hidden="true" />
        <h2 className="ds-empty-title">Open a file to start editing</h2>
        <p className="ds-empty-desc">Drag an audio file here, or choose one from your computer.</p>
        <div className="sfx-studio-empty-actions">
          <button
            type="button"
            className="ds-btn ds-btn-primary"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={14} />
            Open file
          </button>
          <button type="button" className="ds-btn ds-btn-secondary" onClick={onPickFromLibrary}>
            <Library size={14} />
            Pick from Library
          </button>
        </div>
        <p className="sfx-studio-empty-hint">
          In the Library, select a sound and press <kbd className="sfx-kbd">E</kbd> to send it
          here.
        </p>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.ogg,.flac,.aac,.m4a,.aiff"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) {
            onOpenFile(f);
          }
        }}
      />
    </div>
  );
};
