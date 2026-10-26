import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  FolderOpen,
  Heart,
  PanelRightClose,
  Pause,
  Play,
  Sliders,
  Sparkles,
} from "lucide-react";
import {
  fetchFileDetail,
  revealInExplorer,
  updateUserData,
} from "../api";
import { ChunkInfo, FileDetail, SearchHit } from "../types";
import { MiniWaveform } from "./MiniWaveform";

interface DetailPanelProps {
  hit: SearchHit;
  isPlaying: boolean;
  currentTimeS: number | null;
  onTogglePlay: () => void;
  onSeek: (timeS: number) => void;
  onClose: () => void;
  onOpenEditor: () => void;
  onFindSimilarFile: (fileId: string, filename?: string) => void;
  onFindSimilarChunk: (fileId: string, chunkIdx: number, filename?: string) => void;
  onToggleFavorite: () => void;
  onUserUpdated: (
    fileId: string,
    favorite: boolean,
    userTags: string[],
    note: string
  ) => void;
}

export const DetailPanel: React.FC<DetailPanelProps> = ({
  hit,
  isPlaying,
  currentTimeS,
  onTogglePlay,
  onSeek,
  onClose,
  onOpenEditor,
  onFindSimilarFile,
  onFindSimilarChunk,
  onToggleFavorite,
  onUserUpdated,
}) => {
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [selectedChunkIdx, setSelectedChunkIdx] = useState<number>(
    hit.best_chunk_idx || 0
  );
  const [tagInput, setTagInput] = useState<string>("");
  const [noteInput, setNoteInput] = useState<string>(hit.note || "");
  const [copied, setCopied] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string>("");
  const savedNoteRef = useRef<string>(hit.note || "");
  const noteDirtyRef = useRef<boolean>(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setActionError("");
    setCopied(false);
    setTagInput("");
    noteDirtyRef.current = false;
    savedNoteRef.current = hit.note || "";
    setSelectedChunkIdx(hit.best_chunk_idx || 0);
    setNoteInput(hit.note || "");
    fetchFileDetail(hit.file_id)
      .then((d) => {
        if (active) {
          setDetail(d);
          savedNoteRef.current = d.note || "";
          if (!noteDirtyRef.current) {
            setNoteInput(d.note || "");
          }
        }
      })
      .catch(() => {
        if (active) {
          setDetail(null);
        }
      });
    return () => {
      active = false;
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    };
  }, [hit.file_id, hit.best_chunk_idx]);

  const handleSeekAndSelectChunk = (timeS: number) => {
    const chunks: ChunkInfo[] = detail?.chunks || [];
    if (chunks.length > 0) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (const c of chunks) {
        const cMid = (c.start_s + c.end_s) / 2;
        const dist = Math.abs(cMid - timeS);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = c.chunk_idx;
        }
      }
      setSelectedChunkIdx(bestIdx);
    } else {
      setSelectedChunkIdx(Math.max(0, Math.floor(timeS / 5)));
    }
    onSeek(timeS);
  };

  const reportError = (err: unknown) => {
    setActionError(
      err instanceof Error
        ? err.message
        : typeof err === "string"
        ? err
        : "Action failed"
    );
  };

  const handleToggleFavorite = () => {
    onToggleFavorite();
  };

  const handleAddTag = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = tagInput.trim();
    if (!clean) {
      return;
    }
    try {
      const nextTags = Array.from(new Set([...hit.user_tags, clean]));
      const updated = await updateUserData(hit.file_id, { user_tags: nextTags });
      setTagInput("");
      setActionError("");
      onUserUpdated(
        hit.file_id,
        updated.favorite,
        updated.user_tags,
        updated.note
      );
    } catch (err) {
      reportError(err);
    }
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    try {
      const nextTags = hit.user_tags.filter((t) => t !== tagToRemove);
      const updated = await updateUserData(hit.file_id, { user_tags: nextTags });
      setActionError("");
      onUserUpdated(
        hit.file_id,
        updated.favorite,
        updated.user_tags,
        updated.note
      );
    } catch (err) {
      reportError(err);
    }
  };

  const handleSaveNote = async () => {
    if (noteInput === savedNoteRef.current) {
      return;
    }
    try {
      const updated = await updateUserData(hit.file_id, { note: noteInput });
      savedNoteRef.current = updated.note || "";
      setActionError("");
      onUserUpdated(
        hit.file_id,
        updated.favorite,
        updated.user_tags,
        updated.note
      );
    } catch (err) {
      reportError(err);
    }
  };

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(hit.path);
      setCopied(true);
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      reportError("Copy to clipboard failed");
    }
  };

  const rawTags = detail?.tags || hit.tags || {};
  const activeChunk = (detail?.chunks || []).find(
    (c) => c.chunk_idx === selectedChunkIdx
  );
  const selectedChunkRange = activeChunk
    ? { startS: activeChunk.start_s, endS: activeChunk.end_s }
    : { startS: hit.best_offset_s, endS: hit.best_end_s };

  return (
    <aside className="sfx-inspector">
      <div className="ds-panel-head sfx-inspector-head">
        <div className="sfx-inspector-head-row">
          <div className="sfx-inspector-head-lead">
            <button
              type="button"
              onClick={onClose}
              className="sfx-panel-btn"
              aria-label="Collapse inspector"
              title="Collapse inspector"
            >
              <PanelRightClose size={16} />
            </button>
          </div>
          <div className="sfx-inspector-head-actions">
            <button
              type="button"
              onClick={() => revealInExplorer(hit.file_id).catch(reportError)}
              className="sfx-icon-btn"
              aria-label="Reveal file in Explorer"
              title="Reveal file in Explorer"
            >
              <FolderOpen size={14} />
            </button>
            <button
              type="button"
              onClick={handleCopyPath}
              className="sfx-icon-btn"
              aria-label="Copy file path"
              title={copied ? "Copied!" : "Copy full path"}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        </div>
        <div className="sfx-inspector-file">
          <div className="sfx-inspector-filename" title={hit.filename}>
            {hit.filename}
          </div>
          <div className="sfx-inspector-filepath" title={hit.path}>
            {hit.folder}
          </div>
        </div>
      </div>

      <div className="ds-scroll-subtle" style={{ flex: 1 }}>
        {/* Unified Studio Waveform & Shared Transport */}
        <div className="sfx-inspector-section">
          <div className="sfx-audition-bay">
            <MiniWaveform
              key={hit.file_id}
              fileId={hit.file_id}
              durationS={hit.duration_s}
              bestOffsetS={hit.best_offset_s}
              bestEndS={hit.best_end_s}
              currentTimeS={currentTimeS}
              isPlaying={isPlaying}
              height={80}
              selectedChunkRange={selectedChunkRange}
              onSeek={handleSeekAndSelectChunk}
            />
            <div className="sfx-audition-transport">
              <button
                type="button"
                onClick={onTogglePlay}
                className="ds-btn ds-btn-secondary ds-btn-sm"
              >
                {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                {isPlaying ? "Pause" : "Audition"}
              </button>
              <span className="sfx-audition-time">
                {currentTimeS !== null
                  ? `${currentTimeS.toFixed(2)}s / ${hit.duration_s.toFixed(2)}s`
                  : hit.duration_s > 12.5
                  ? `${selectedChunkRange.startS.toFixed(
                      1
                    )}s – ${selectedChunkRange.endS.toFixed(
                      1
                    )}s`
                  : `${hit.duration_s.toFixed(2)}s`}
              </span>
            </div>
          </div>

          <div className="sfx-similar-actions">
            <button
              type="button"
              onClick={onOpenEditor}
              className="ds-btn ds-btn-primary"
              title="Open in Audio Editor (E)"
            >
              <Sliders size={14} />
              <span className="sfx-btn-label">Edit Audio (E)</span>
            </button>
            <button
              type="button"
              onClick={() => onFindSimilarFile(hit.file_id, hit.filename)}
              className="ds-btn ds-btn-secondary"
            >
              <Sparkles size={14} />
              <span className="sfx-btn-label">Find similar sounds</span>
            </button>
            {hit.duration_s > 12.5 && (
              <button
                type="button"
                onClick={() =>
                  onFindSimilarChunk(
                    hit.file_id,
                    selectedChunkIdx,
                    `${hit.filename} (${selectedChunkRange.startS.toFixed(
                      1
                    )}s – ${selectedChunkRange.endS.toFixed(1)}s)`
                  )
                }
                className="ds-btn ds-btn-secondary ds-btn-sm"
              >
                <Sparkles size={14} />
                <span className="sfx-btn-label">
                  Similar to this section
                </span>
              </button>
            )}
          </div>
        </div>

        {/* 6-Cell Studio Parameter Readout Grid */}
        <div className="sfx-inspector-section">
          <div
            className="ds-panel-title"
            style={{ marginBottom: "var(--space-3)" }}
          >
            Specs
          </div>
          <div className="sfx-param-grid">
            <div className="sfx-param-cell">
              <span className="sfx-param-label">Duration</span>
              <span className="sfx-param-val">
                {hit.duration_s.toFixed(2)}s
              </span>
            </div>
            <div className="sfx-param-cell">
              <span className="sfx-param-label">Loudness</span>
              <span className="sfx-param-val">
                {hit.lufs_integrated !== null
                  ? `${hit.lufs_integrated.toFixed(1)} LUFS`
                  : "—"}
              </span>
            </div>
            <div className="sfx-param-cell">
              <span className="sfx-param-label">Peak</span>
              <span className="sfx-param-val">
                {hit.peak_dbfs.toFixed(1)} dBFS
              </span>
            </div>
            <div className="sfx-param-cell">
              <span className="sfx-param-label">Sample rate</span>
              <span className="sfx-param-val">
                {(hit.sample_rate / 1000).toFixed(1)} kHz
              </span>
            </div>
            <div className="sfx-param-cell">
              <span className="sfx-param-label">Channels</span>
              <span className="sfx-param-val">
                {hit.channels === 1
                  ? "Mono"
                  : hit.channels === 2
                  ? "Stereo"
                  : `${hit.channels} ch`}
              </span>
            </div>
            <div className="sfx-param-cell">
              <span className="sfx-param-label">Format</span>
              <span className="sfx-param-val">
                {hit.format.split("/")[0].toUpperCase()}
              </span>
            </div>
          </div>
        </div>

        {/* Curation */}
        <div className="sfx-inspector-section">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "var(--space-3)",
            }}
          >
            <span className="ds-panel-title">Curation</span>
            <button
              type="button"
              onClick={handleToggleFavorite}
              className={`ds-btn ds-btn-sm ${
                hit.favorite ? "ds-btn-danger" : "ds-btn-secondary"
              }`}
            >
              <Heart size={14} />
              {hit.favorite ? "Favorited" : "Favorite"}
            </button>
          </div>
          {actionError && (
            <div className="ds-input-error" style={{ marginBottom: "var(--space-2)" }}>
              {actionError}
            </div>
          )}

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "var(--space-1)",
              marginBottom: "var(--space-3)",
            }}
          >
            {hit.user_tags.map((t) => (
              <span key={t} className="ds-badge ds-badge-accent">
                {t}
                <button
                  type="button"
                  onClick={() => handleRemoveTag(t)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "inherit",
                    marginLeft: 6,
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          <form
            onSubmit={handleAddTag}
            style={{
              display: "flex",
              gap: "var(--space-2)",
              marginBottom: "var(--space-3)",
            }}
          >
            <div className="ds-input-box" style={{ flex: 1 }}>
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="Add tag"
                className="ds-input"
              />
            </div>
            <button type="submit" className="ds-btn ds-btn-secondary">
              Add
            </button>
          </form>

          <div className="ds-input-field">
            <label className="ds-input-label">Notes</label>
            <div
              className="ds-input-box"
              style={{
                height: "auto",
                padding: "var(--space-2) var(--space-3)",
              }}
            >
              <textarea
                rows={2}
                value={noteInput}
                onChange={(e) => {
                  noteDirtyRef.current = true;
                  setNoteInput(e.target.value);
                }}
                onBlur={handleSaveNote}
                placeholder="Add production note"
                className="ds-input"
                style={{ resize: "vertical" }}
              />
            </div>
          </div>
        </div>

        {/* Embedded Tags */}
        <div className="sfx-inspector-section">
          <div
            className="ds-panel-title"
            style={{ marginBottom: "var(--space-3)" }}
          >
            Embedded metadata
          </div>
          {Object.keys(rawTags).length === 0 ? (
            <div
              style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--text-tertiary)",
              }}
            >
              No embedded container or BWF/iXML tags.
            </div>
          ) : (
            Object.entries(rawTags).map(([k, v]) => (
              <div key={k} className="sfx-kv-row">
                <span className="sfx-kv-key">{k}</span>
                <span className="sfx-kv-val">{String(v)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  );
};
