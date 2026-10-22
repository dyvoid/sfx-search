import React, { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import {
  Copy,
  FolderOpen,
  Heart,
  Pause,
  Play,
  Sparkles,
  X,
} from "lucide-react";
import {
  fetchFileDetail,
  revealInExplorer,
  updateUserData,
} from "../api";
import { ChunkInfo, FileDetail, SearchHit } from "../types";

interface DetailPanelProps {
  hit: SearchHit;
  onClose: () => void;
  onFindSimilarFile: (fileId: string) => void;
  onFindSimilarChunk: (fileId: string, chunkIdx: number) => void;
  onUserUpdated: (
    fileId: string,
    favorite: boolean,
    userTags: string[],
    note: string
  ) => void;
  onStopGlobalAudio: () => void;
}

function readToken(varName: string, fallback: string): string {
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return val || fallback;
}

export const DetailPanel: React.FC<DetailPanelProps> = ({
  hit,
  onClose,
  onFindSimilarFile,
  onFindSimilarChunk,
  onUserUpdated,
  onStopGlobalAudio,
}) => {
  const waveformContainerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [selectedChunkIdx, setSelectedChunkIdx] = useState<number>(
    hit.best_chunk_idx || 0
  );
  const [tagInput, setTagInput] = useState<string>("");
  const [noteInput, setNoteInput] = useState<string>(hit.note || "");
  const [copied, setCopied] = useState<boolean>(false);
  const [wsPlaying, setWsPlaying] = useState<boolean>(false);

  useEffect(() => {
    setSelectedChunkIdx(hit.best_chunk_idx || 0);
    setNoteInput(hit.note || "");
    fetchFileDetail(hit.file_id)
      .then((d) => {
        setDetail(d);
        setNoteInput(d.note || "");
      })
      .catch(() => {
        setDetail(null);
      });
  }, [hit.file_id]);

  useEffect(() => {
    const container = waveformContainerRef.current;
    if (!container) {
      return;
    }

    const waveColor = readToken("--gray-500", "oklch(52% 0.015 260)");
    const progressColor = readToken("--primary", "oklch(58% 0.17 275)");
    const cursorColor = readToken("--accent-2-400", "oklch(78% 0.08 190)");
    const regionColor = readToken(
      "--accent-1-muted-bg",
      "oklch(72% 0.15 55 / 0.22)"
    );

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container,
      waveColor,
      progressColor,
      cursorColor,
      barWidth: 2,
      barGap: 1,
      height: 88,
      normalize: true,
      url: `/api/audio/${encodeURIComponent(hit.file_id)}`,
      plugins: [regions],
    });

    ws.on("ready", () => {
      const dur = ws.getDuration() || hit.duration_s || 10;
      const start = Math.min(dur, Math.max(0, hit.best_offset_s));
      const end = Math.min(
        dur,
        Math.max(start + 0.5, hit.best_end_s || start + 10)
      );
      regions.addRegion({
        start,
        end,
        color: regionColor,
        drag: true,
        resize: true,
      });
    });

    regions.on("region-updated", (reg) => {
      const mid = (reg.start + reg.end) / 2;
      const chunks: ChunkInfo[] = detail?.chunks || [];
      if (chunks.length > 0) {
        let bestIdx = 0;
        let bestDist = Infinity;
        for (const c of chunks) {
          const cMid = (c.start_s + c.end_s) / 2;
          const dist = Math.abs(cMid - mid);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = c.chunk_idx;
          }
        }
        setSelectedChunkIdx(bestIdx);
      } else {
        setSelectedChunkIdx(Math.max(0, Math.floor(reg.start / 5)));
      }
    });

    ws.on("play", () => {
      onStopGlobalAudio();
      setWsPlaying(true);
    });
    ws.on("pause", () => setWsPlaying(false));
    ws.on("finish", () => setWsPlaying(false));

    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [hit.file_id]);

  const handleToggleFavorite = async () => {
    const nextFav = !hit.favorite;
    const updated = await updateUserData(hit.file_id, { favorite: nextFav });
    onUserUpdated(
      hit.file_id,
      updated.favorite,
      updated.user_tags,
      updated.note
    );
  };

  const handleAddTag = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = tagInput.trim();
    if (!clean) {
      return;
    }
    const nextTags = Array.from(new Set([...hit.user_tags, clean]));
    setTagInput("");
    const updated = await updateUserData(hit.file_id, { user_tags: nextTags });
    onUserUpdated(
      hit.file_id,
      updated.favorite,
      updated.user_tags,
      updated.note
    );
  };

  const handleRemoveTag = async (tagToRemove: string) => {
    const nextTags = hit.user_tags.filter((t) => t !== tagToRemove);
    const updated = await updateUserData(hit.file_id, { user_tags: nextTags });
    onUserUpdated(
      hit.file_id,
      updated.favorite,
      updated.user_tags,
      updated.note
    );
  };

  const handleSaveNote = async () => {
    const updated = await updateUserData(hit.file_id, { note: noteInput });
    onUserUpdated(
      hit.file_id,
      updated.favorite,
      updated.user_tags,
      updated.note
    );
  };

  const handleCopyPath = async () => {
    await navigator.clipboard.writeText(hit.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const rawTags = detail?.tags || hit.tags || {};

  return (
    <aside className="sfx-inspector">
      <div className="ds-panel-head">
        <div style={{ minWidth: 0, paddingRight: "var(--space-2)" }}>
          <div
            style={{
              fontSize: "var(--font-size-base)",
              fontWeight: 600,
              color: "var(--text-primary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={hit.filename}
          >
            {hit.filename}
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-2xs)",
              color: "var(--text-tertiary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={hit.path}
          >
            {hit.path}
          </div>
        </div>
        <button
          onClick={onClose}
          className="sfx-icon-btn"
          aria-label="Close inspector"
        >
          <X size={14} />
        </button>
      </div>

      <div className="ds-scroll-subtle" style={{ flex: 1 }}>
        {/* Waveform */}
        <div className="sfx-inspector-section">
          <div
            style={{
              padding: "var(--space-3)",
              background: "var(--surface-sunken)",
              border: "var(--border-width) solid var(--border-subtle)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <div ref={waveformContainerRef} />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginTop: "var(--space-3)",
              }}
            >
              <button
                type="button"
                onClick={() => wsRef.current?.playPause()}
                className="ds-btn ds-btn-primary ds-btn-sm"
              >
                {wsPlaying ? <Pause size={14} /> : <Play size={14} />}
                {wsPlaying ? "Pause" : "Audition"}
              </button>
              <span
                className="ds-tnum"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--font-size-2xs)",
                  color: "var(--text-tertiary)",
                }}
              >
                {hit.best_offset_s.toFixed(1)}s – {hit.best_end_s.toFixed(1)}s
                (chunk #{selectedChunkIdx})
              </span>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "var(--space-2)",
              marginTop: "var(--space-3)",
            }}
          >
            <button
              type="button"
              onClick={() => onFindSimilarFile(hit.file_id)}
              className="ds-btn ds-btn-secondary ds-btn-sm"
            >
              <Sparkles size={14} />
              Similar file
            </button>
            <button
              type="button"
              onClick={() => onFindSimilarChunk(hit.file_id, selectedChunkIdx)}
              className="ds-btn ds-btn-secondary ds-btn-sm"
            >
              <Sparkles size={14} />
              Similar chunk #{selectedChunkIdx}
            </button>
            <button
              type="button"
              onClick={() => revealInExplorer(hit.file_id)}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              <FolderOpen size={14} />
              Reveal file
            </button>
            <button
              type="button"
              onClick={handleCopyPath}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              <Copy size={14} />
              {copied ? "Copied" : "Copy path"}
            </button>
          </div>
        </div>

        {/* Acoustic Specs */}
        <div className="sfx-inspector-section">
          <div
            className="ds-panel-title"
            style={{ marginBottom: "var(--space-3)" }}
          >
            Parameters
          </div>
          <div className="sfx-kv-row">
            <span className="sfx-kv-key">Duration</span>
            <span className="sfx-kv-val">{hit.duration_s.toFixed(2)} s</span>
          </div>
          <div className="sfx-kv-row">
            <span className="sfx-kv-key">Format</span>
            <span className="sfx-kv-val">{hit.format}</span>
          </div>
          <div className="sfx-kv-row">
            <span className="sfx-kv-key">Sample rate</span>
            <span className="sfx-kv-val">
              {hit.sample_rate} Hz · {hit.channels} ch
            </span>
          </div>
          <div className="sfx-kv-row">
            <span className="sfx-kv-key">Loudness</span>
            <span className="sfx-kv-val">
              {hit.lufs_integrated !== null
                ? `${hit.lufs_integrated.toFixed(1)} LUFS`
                : "—"}
            </span>
          </div>
          <div className="sfx-kv-row">
            <span className="sfx-kv-key">Peak</span>
            <span className="sfx-kv-val">{hit.peak_dbfs.toFixed(1)} dBFS</span>
          </div>
          <div className="sfx-kv-row">
            <span className="sfx-kv-key">Loop score</span>
            <span className="sfx-kv-val">
              {hit.loop_score !== null ? hit.loop_score.toFixed(2) : "—"}
            </span>
          </div>
          <div className="sfx-kv-row">
            <span className="sfx-kv-key">Scores (RRF / CLAP / BM25)</span>
            <span className="sfx-kv-val" style={{ color: "var(--primary-400)" }}>
              {hit.rrf_score.toFixed(4)} /{" "}
              {hit.clap_score !== null ? hit.clap_score.toFixed(3) : "—"} /{" "}
              {hit.bm25_score !== null ? hit.bm25_score.toFixed(1) : "—"}
            </span>
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
              style={{ height: "auto", padding: "var(--space-2) var(--space-3)" }}
            >
              <textarea
                rows={2}
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
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
