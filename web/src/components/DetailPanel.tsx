import React, { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import {
  Copy,
  FolderOpen,
  Heart,
  Play,
  Sparkles,
  Tag,
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

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container,
      waveColor: "#71717a",
      progressColor: "#f59e0b",
      cursorColor: "#38bdf8",
      barWidth: 2,
      barGap: 1,
      height: 96,
      normalize: true,
      url: `/api/audio/${encodeURIComponent(hit.file_id)}`,
      plugins: [regions],
    });

    ws.on("ready", () => {
      const dur = ws.getDuration() || hit.duration_s || 10;
      const start = Math.min(dur, Math.max(0, hit.best_offset_s));
      const end = Math.min(dur, Math.max(start + 0.5, hit.best_end_s || start + 10));
      regions.addRegion({
        start,
        end,
        color: "rgba(245, 158, 11, 0.22)",
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
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l border-zinc-800 bg-zinc-900/95 text-sm">
      <div className="flex items-start justify-between border-b border-zinc-800 p-4">
        <div className="min-w-0 pr-2">
          <h2 className="truncate font-semibold text-zinc-100" title={hit.filename}>
            {hit.filename}
          </h2>
          <p className="truncate text-xs text-zinc-400" title={hit.path}>
            {hit.path}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          title="Close detail panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {/* Waveform */}
        <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <div ref={waveformContainerRef} className="w-full" />
          <div className="flex items-center justify-between pt-1 text-xs text-zinc-400">
            <button
              onClick={() => wsRef.current?.playPause()}
              className="flex items-center gap-1.5 rounded bg-amber-500 px-2.5 py-1 font-medium text-zinc-950 hover:bg-amber-400"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              {wsPlaying ? "Pause" : "Play Detail"}
            </button>
            <span>
              Best window: {hit.best_offset_s.toFixed(1)}s –{" "}
              {hit.best_end_s.toFixed(1)}s (chunk #{selectedChunkIdx})
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onFindSimilarFile(hit.file_id)}
            className="flex items-center justify-center gap-1.5 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-100 hover:bg-zinc-700"
          >
            <Sparkles className="h-3.5 w-3.5 text-amber-400" />
            Similar (Whole File)
          </button>
          <button
            onClick={() => onFindSimilarChunk(hit.file_id, selectedChunkIdx)}
            className="flex items-center justify-center gap-1.5 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-100 hover:bg-zinc-700"
          >
            <Sparkles className="h-3.5 w-3.5 text-sky-400" />
            Similar (Chunk #{selectedChunkIdx})
          </button>
          <button
            onClick={() => revealInExplorer(hit.file_id)}
            className="flex items-center justify-center gap-1.5 rounded border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Reveal in Folder
          </button>
          <button
            onClick={handleCopyPath}
            className="flex items-center justify-center gap-1.5 rounded border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? "Copied!" : "Copy Path"}
          </button>
        </div>

        {/* Acoustic & File Specs */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Audio Properties & Scores
          </h3>
          <div className="grid grid-cols-2 gap-y-1.5 text-xs">
            <span className="text-zinc-400">Duration:</span>
            <span className="font-mono text-zinc-200">
              {hit.duration_s.toFixed(2)} s
            </span>
            <span className="text-zinc-400">Format:</span>
            <span className="font-mono text-zinc-200">{hit.format}</span>
            <span className="text-zinc-400">Sample Rate / Ch:</span>
            <span className="font-mono text-zinc-200">
              {hit.sample_rate} Hz / {hit.channels} ch
            </span>
            <span className="text-zinc-400">Loudness (LUFS):</span>
            <span className="font-mono text-zinc-200">
              {hit.lufs_integrated !== null
                ? `${hit.lufs_integrated.toFixed(1)} LUFS`
                : "N/A"}
            </span>
            <span className="text-zinc-400">Peak:</span>
            <span className="font-mono text-zinc-200">
              {hit.peak_dbfs.toFixed(1)} dBFS
            </span>
            <span className="text-zinc-400">Loop Score:</span>
            <span className="font-mono text-zinc-200">
              {hit.loop_score !== null ? hit.loop_score.toFixed(2) : "N/A"}
            </span>
            <span className="text-zinc-400">RRF / CLAP / BM25:</span>
            <span className="font-mono text-amber-400">
              {hit.rrf_score.toFixed(4)} /{" "}
              {hit.clap_score !== null ? hit.clap_score.toFixed(3) : "-"} /{" "}
              {hit.bm25_score !== null ? hit.bm25_score.toFixed(2) : "-"}
            </span>
          </div>
        </div>

        {/* User Curation */}
        <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              User Curation
            </h3>
            <button
              onClick={handleToggleFavorite}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
                hit.favorite
                  ? "bg-rose-500/20 text-rose-400"
                  : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Heart
                className={`h-3.5 w-3.5 ${hit.favorite ? "fill-current" : ""}`}
              />
              {hit.favorite ? "Favorited" : "Favorite"}
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {hit.user_tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs text-amber-300"
              >
                <Tag className="h-3 w-3" />
                {t}
                <button
                  onClick={() => handleRemoveTag(t)}
                  className="ml-0.5 text-amber-400/70 hover:text-amber-200"
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          <form onSubmit={handleAddTag} className="flex gap-1.5">
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="Add user tag..."
              className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-100 focus:border-amber-500 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
            >
              Add
            </button>
          </form>

          <div className="space-y-1.5">
            <textarea
              rows={2}
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              onBlur={handleSaveNote}
              placeholder="Add production notes..."
              className="w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-xs text-zinc-100 focus:border-amber-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Embedded Metadata Tags */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Embedded Tags (BWF / iXML / Container)
          </h3>
          {Object.keys(rawTags).length === 0 ? (
            <p className="text-xs text-zinc-500">No embedded tags extracted.</p>
          ) : (
            <div className="space-y-1 text-xs">
              {Object.entries(rawTags).map(([k, v]) => (
                <div key={k} className="grid grid-cols-3 gap-2 border-b border-zinc-900 py-1">
                  <span className="truncate font-mono text-zinc-400" title={k}>
                    {k}
                  </span>
                  <span className="col-span-2 break-words text-zinc-200">
                    {String(v)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
