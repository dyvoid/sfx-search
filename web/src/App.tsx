import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Clock,
  Filter,
  Heart,
  History,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Search,
  Sparkles,
  Upload,
  Volume2,
} from "lucide-react";
import {
  fetchAvailableFilters,
  fetchStats,
  findSimilarById,
  findSimilarByUpload,
  searchSounds,
  updateUserData,
} from "./api";
import { DetailPanel } from "./components/DetailPanel";
import { MiniWaveform } from "./components/MiniWaveform";
import {
  AvailableFilters,
  DEFAULT_FILTERS,
  FilterState,
  LibraryStats,
  SearchHit,
  SearchMode,
} from "./types";

const LS_HISTORY_KEY = "sfxsearch_query_history_v1";
const LS_FILTERS_KEY = "sfxsearch_last_filters_v1";

export const App: React.FC = () => {
  const [query, setQuery] = useState<string>("");
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [filters, setFilters] = useState<FilterState>(() => {
    try {
      const saved = localStorage.getItem(LS_FILTERS_KEY);
      return saved ? { ...DEFAULT_FILTERS, ...JSON.parse(saved) } : DEFAULT_FILTERS;
    } catch {
      return DEFAULT_FILTERS;
    }
  });
  const [showFilters, setShowFilters] = useState<boolean>(false);
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(LS_HISTORY_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [showHistory, setShowHistory] = useState<boolean>(false);

  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [statusLabel, setStatusLabel] = useState<string>("");
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [availFilters, setAvailFilters] = useState<AvailableFilters | null>(null);

  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [detailOpen, setDetailOpen] = useState<boolean>(false);

  const [playingFileId, setPlayingFileId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTimeS, setCurrentTimeS] = useState<number>(0);
  const [startAtBestOffset, setStartAtBestOffset] = useState<boolean>(true);
  const [loopEnabled, setLoopEnabled] = useState<boolean>(false);

  const [isDraggingFile, setIsDraggingFile] = useState<boolean>(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    fetchStats().then(setStats).catch(() => {});
    fetchAvailableFilters().then(setAvailFilters).catch(() => {});
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LS_FILTERS_KEY, JSON.stringify(filters));
    } catch {
      // ignore storage errors
    }
  }, [filters]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.loop = loopEnabled;
    }
  }, [loopEnabled]);

  const recordHistory = useCallback((q: string) => {
    const clean = q.trim();
    if (!clean) {
      return;
    }
    setHistory((prev) => {
      const next = [clean, ...prev.filter((item) => item !== clean)].slice(0, 15);
      try {
        localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const runSearch = useCallback(
    async (qOverride?: string, modeOverride?: SearchMode, filtersOverride?: FilterState) => {
      const q = qOverride !== undefined ? qOverride : query;
      const m = modeOverride !== undefined ? modeOverride : mode;
      const f = filtersOverride !== undefined ? filtersOverride : filters;

      setLoading(true);
      setStatusLabel("");
      try {
        const hits = await searchSounds(q, m, f, 50);
        setResults(hits);
        setSelectedIndex(0);
        if (q.trim()) {
          recordHistory(q);
        }
      } catch (err) {
        setStatusLabel(err instanceof Error ? err.message : "Search failed");
      } finally {
        setLoading(false);
      }
    },
    [query, mode, filters, recordHistory]
  );

  useEffect(() => {
    runSearch("", "keyword_only", filters);
  }, []);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setIsPlaying(false);
  }, []);

  const playHit = useCallback(
    (hit: SearchHit, explicitSeekS?: number) => {
      const audio = audioRef.current;
      if (!audio) {
        return;
      }

      const targetUrl = `/api/audio/${encodeURIComponent(hit.file_id)}`;
      const startOffset =
        explicitSeekS !== undefined
          ? explicitSeekS
          : startAtBestOffset
          ? hit.best_offset_s
          : 0;

      if (playingFileId === hit.file_id && explicitSeekS === undefined) {
        if (!audio.paused) {
          audio.pause();
          setIsPlaying(false);
        } else {
          audio.play().catch(() => {});
          setIsPlaying(true);
        }
        return;
      }

      setPlayingFileId(hit.file_id);
      audio.src = targetUrl;
      audio.loop = loopEnabled;
      audio.currentTime = Math.max(0, startOffset);
      audio
        .play()
        .then(() => {
          setIsPlaying(true);
        })
        .catch(() => {
          setIsPlaying(false);
        });
    },
    [playingFileId, startAtBestOffset, loopEnabled]
  );

  // Keyboard navigation: Up/Down moves selection, Space plays/pauses, Enter toggles detail panel
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        if (e.key === "Escape") {
          (e.target as HTMLElement).blur();
        }
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = Math.min(results.length - 1, Math.max(0, prev + 1));
          rowRefs.current[next]?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = Math.max(0, prev - 1);
          rowRefs.current[next]?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === " ") {
        e.preventDefault();
        const currentHit = results[selectedIndex];
        if (currentHit) {
          playHit(currentHit);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (results[selectedIndex]) {
          setDetailOpen((prev) => !prev);
        }
      } else if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [results, selectedIndex, playHit]);

  const handleFindSimilarFile = async (fileId: string) => {
    setLoading(true);
    try {
      const hits = await findSimilarById(fileId, undefined, 40);
      setResults(hits);
      setSelectedIndex(0);
      setStatusLabel(`Showing sounds similar to ${fileId.slice(0, 8)}...`);
    } finally {
      setLoading(false);
    }
  };

  const handleFindSimilarChunk = async (fileId: string, chunkIdx: number) => {
    setLoading(true);
    try {
      const hits = await findSimilarById(fileId, chunkIdx, 40);
      setResults(hits);
      setSelectedIndex(0);
      setStatusLabel(
        `Showing sounds similar to ${fileId.slice(0, 8)}... (chunk #${chunkIdx})`
      );
    } finally {
      setLoading(false);
    }
  };

  const handleDropFile = async (file: File) => {
    setLoading(true);
    setStatusLabel(`Embedding dropped reference '${file.name}'...`);
    try {
      const hits = await findSimilarByUpload(file, 40);
      setResults(hits);
      setSelectedIndex(0);
      setStatusLabel(`Showing sounds similar to uploaded '${file.name}'`);
    } catch (err) {
      setStatusLabel(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setLoading(false);
    }
  };

  const handleToggleFavoriteRow = async (
    e: React.MouseEvent,
    hit: SearchHit
  ) => {
    e.stopPropagation();
    const updated = await updateUserData(hit.file_id, {
      favorite: !hit.favorite,
    });
    handleUserUpdated(
      hit.file_id,
      updated.favorite,
      updated.user_tags,
      updated.note
    );
  };

  const handleUserUpdated = (
    fileId: string,
    favorite: boolean,
    userTags: string[],
    note: string
  ) => {
    setResults((prev) =>
      prev.map((h) =>
        h.file_id === fileId
          ? { ...h, favorite, user_tags: userTags, note }
          : h
      )
    );
    fetchAvailableFilters().then(setAvailFilters).catch(() => {});
  };

  const selectedHit = results[selectedIndex] || null;

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingFile(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) {
          return;
        }
        setIsDraggingFile(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDraggingFile(false);
        const f = e.dataTransfer.files?.[0];
        if (f) {
          handleDropFile(f);
        }
      }}
    >
      {/* Hidden shared HTML5 audio element */}
      <audio
        ref={audioRef}
        onTimeUpdate={(e) => setCurrentTimeS(e.currentTarget.currentTime)}
        onEnded={() => setIsPlaying(false)}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
      />

      {/* Drag & drop overlay */}
      {isDraggingFile && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/85 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-amber-400 bg-zinc-900/90 px-12 py-10 text-center">
            <Upload className="h-10 w-10 text-amber-400" />
            <p className="text-lg font-semibold text-zinc-100">
              Drop reference audio file to find acoustically similar sounds
            </p>
            <p className="text-xs text-zinc-400">
              Supports WAV, FLAC, AIFF, MP3, OGG, OPUS, M4A
            </p>
          </div>
        </div>
      )}

      {/* Top Header & Search Bar */}
      <header className="border-b border-zinc-800 bg-zinc-900/70 px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Brand */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500 text-zinc-950">
              <Volume2 className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight text-zinc-100">
                sfx-search
              </h1>
              <p className="text-[11px] text-zinc-400">
                {stats
                  ? `${stats.ok_files.toLocaleString()} sounds (${stats.total_duration_hours.toFixed(
                      1
                    )}h) · ${stats.total_chunks.toLocaleString()} chunks`
                  : "Local CLAP + BM25 Hybrid Search"}
              </p>
            </div>
          </div>

          {/* Search input + mode selector */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setShowHistory(false);
              runSearch();
            }}
            className="relative flex flex-1 max-w-3xl items-center gap-2"
          >
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onFocus={() => setShowHistory(true)}
                onBlur={() => setTimeout(() => setShowHistory(false), 180)}
                onChange={(e) => setQuery(e.target.value)}
                placeholder='Describe a sound ("slow wooden floor creak, large empty house") or use dur:2-8 -voice...'
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 py-2 pl-9 pr-20 text-sm text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
              />
              {history.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowHistory((prev) => !prev)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-200"
                  title="Recent queries"
                >
                  <History className="h-4 w-4" />
                </button>
              )}

              {/* History dropdown */}
              {showHistory && history.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-lg border border-zinc-800 bg-zinc-900 py-1 shadow-xl">
                  <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                    Recent Queries
                  </div>
                  {history.map((hItem) => (
                    <button
                      key={hItem}
                      type="button"
                      onMouseDown={() => {
                        setQuery(hItem);
                        setShowHistory(false);
                        runSearch(hItem);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
                    >
                      <Clock className="h-3 w-3 text-zinc-500" />
                      {hItem}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <select
              value={mode}
              onChange={(e) => {
                const nextMode = e.target.value as SearchMode;
                setMode(nextMode);
                runSearch(query, nextMode, filters);
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs font-medium text-zinc-200 focus:border-amber-500 focus:outline-none"
            >
              <option value="hybrid">Hybrid (RRF)</option>
              <option value="audio_only">Audio Semantic (CLAP)</option>
              <option value="keyword_only">Keyword (BM25)</option>
            </select>

            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-zinc-950 transition hover:bg-amber-400 disabled:opacity-50"
            >
              {loading ? "Searching..." : "Search"}
            </button>

            <button
              type="button"
              onClick={() => setShowFilters((prev) => !prev)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                showFilters
                  ? "border-amber-500/60 bg-amber-500/15 text-amber-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              <Filter className="h-3.5 w-3.5" />
              Filters
            </button>
          </form>

          {/* Playback transport toggles */}
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => setStartAtBestOffset((prev) => !prev)}
              className={`rounded-md border px-2.5 py-1.5 font-medium transition ${
                startAtBestOffset
                  ? "border-amber-500/50 bg-amber-500/15 text-amber-300"
                  : "border-zinc-800 bg-zinc-900 text-zinc-400"
              }`}
              title="Start playback at best-matching 10s window offset vs 0:00"
            >
              {startAtBestOffset ? "Start @ Best Match" : "Start @ 0:00"}
            </button>

            <button
              type="button"
              onClick={() => setLoopEnabled((prev) => !prev)}
              className={`flex items-center gap-1 rounded-md border px-2.5 py-1.5 font-medium transition ${
                loopEnabled
                  ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                  : "border-zinc-800 bg-zinc-900 text-zinc-400"
              }`}
              title="Toggle loop playback"
            >
              <Repeat className="h-3.5 w-3.5" />
              Loop
            </button>

            <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-zinc-300 hover:bg-zinc-800">
              <Upload className="h-3.5 w-3.5 text-amber-400" />
              <span>Drop / Upload Ref</span>
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    handleDropFile(f);
                  }
                }}
              />
            </label>
          </div>
        </div>

        {/* Collapsible Filter Panel */}
        {showFilters && (
          <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-zinc-800/80 pt-3 text-xs">
            <div>
              <label className="mb-1 block text-[11px] text-zinc-400">
                Duration (s)
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  step="0.5"
                  placeholder="Min"
                  value={filters.minDuration}
                  onChange={(e) =>
                    setFilters({ ...filters, minDuration: e.target.value })
                  }
                  className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
                />
                <span className="text-zinc-500">–</span>
                <input
                  type="number"
                  step="0.5"
                  placeholder="Max"
                  value={filters.maxDuration}
                  onChange={(e) =>
                    setFilters({ ...filters, maxDuration: e.target.value })
                  }
                  className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-zinc-400">
                Loudness (LUFS)
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  step="1"
                  placeholder="-40"
                  value={filters.minLufs}
                  onChange={(e) =>
                    setFilters({ ...filters, minLufs: e.target.value })
                  }
                  className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
                />
                <span className="text-zinc-500">–</span>
                <input
                  type="number"
                  step="1"
                  placeholder="0"
                  value={filters.maxLufs}
                  onChange={(e) =>
                    setFilters({ ...filters, maxLufs: e.target.value })
                  }
                  className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-zinc-400">
                Format
              </label>
              <select
                value={filters.format}
                onChange={(e) =>
                  setFilters({ ...filters, format: e.target.value })
                }
                className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-zinc-200"
              >
                <option value="">All Formats</option>
                {(availFilters?.formats || ["wav", "flac", "mp3", "ogg", "aiff"]).map(
                  (fmt) => (
                    <option key={fmt} value={fmt}>
                      {fmt.toUpperCase()}
                    </option>
                  )
                )}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-zinc-400">
                Source Root
              </label>
              <select
                value={filters.root}
                onChange={(e) =>
                  setFilters({ ...filters, root: e.target.value })
                }
                className="max-w-[200px] truncate rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-zinc-200"
              >
                <option value="">All Roots</option>
                {(availFilters?.roots || []).map((rt) => (
                  <option key={rt} value={rt}>
                    {rt}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-zinc-400">
                Min Loop Score
              </label>
              <input
                type="number"
                step="0.1"
                min="0"
                max="1"
                placeholder="0.0 - 1.0"
                value={filters.minLoopScore}
                onChange={(e) =>
                  setFilters({ ...filters, minLoopScore: e.target.value })
                }
                className="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-zinc-400">
                User Tag
              </label>
              <select
                value={filters.userTag}
                onChange={(e) =>
                  setFilters({ ...filters, userTag: e.target.value })
                }
                className="rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-zinc-200"
              >
                <option value="">Any Tag</option>
                {(availFilters?.user_tags || []).map((t) => (
                  <option key={t} value={t}>
                    #{t}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex cursor-pointer items-center gap-1.5 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-zinc-200">
              <input
                type="checkbox"
                checked={filters.favoritesOnly}
                onChange={(e) =>
                  setFilters({ ...filters, favoritesOnly: e.target.checked })
                }
              />
              <Heart className="h-3.5 w-3.5 text-rose-400" />
              Favorites Only
            </label>

            <button
              type="button"
              onClick={() => runSearch(query, mode, filters)}
              className="rounded bg-amber-500/20 px-3 py-1 font-medium text-amber-300 hover:bg-amber-500/30"
            >
              Apply
            </button>

            <button
              type="button"
              onClick={() => {
                setFilters(DEFAULT_FILTERS);
                runSearch(query, mode, DEFAULT_FILTERS);
              }}
              className="flex items-center gap-1 rounded px-2.5 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          </div>
        )}
      </header>

      {/* Main Content Area: Results List + Optional Detail Panel */}
      <div className="flex flex-1 overflow-hidden">
        <main className="flex flex-1 flex-col overflow-hidden">
          {/* Status bar */}
          <div className="flex items-center justify-between border-b border-zinc-900 bg-zinc-950 px-5 py-1.5 text-xs text-zinc-400">
            <span>
              {statusLabel ||
                `${results.length} result${results.length === 1 ? "" : "s"}`}
            </span>
            <span className="text-[11px] text-zinc-500">
              Shortcuts: <kbd className="rounded bg-zinc-800 px-1">↑</kbd>{" "}
              <kbd className="rounded bg-zinc-800 px-1">↓</kbd> navigate ·{" "}
              <kbd className="rounded bg-zinc-800 px-1">Space</kbd> play/pause ·{" "}
              <kbd className="rounded bg-zinc-800 px-1">Enter</kbd> details ·{" "}
              <kbd className="rounded bg-zinc-800 px-1">/</kbd> search
            </span>
          </div>

          {/* Results rows */}
          <div className="flex-1 divide-y divide-zinc-900 overflow-y-auto">
            {results.length === 0 && !loading ? (
              <div className="flex h-64 flex-col items-center justify-center gap-2 text-zinc-500">
                <p className="text-sm">No matching sound effects found.</p>
                <p className="text-xs">
                  Try broadening your filters or indexing a folder with{" "}
                  <code className="rounded bg-zinc-900 px-1.5 py-0.5 text-zinc-300">
                    uv run sfxsearch index &lt;path&gt;
                  </code>
                </p>
              </div>
            ) : (
              results.map((hit, idx) => {
                const isSelected = idx === selectedIndex;
                const isRowPlaying =
                  playingFileId === hit.file_id && isPlaying;
                const rowTime =
                  playingFileId === hit.file_id ? currentTimeS : null;

                return (
                  <div
                    key={hit.file_id}
                    ref={(el) => {
                      rowRefs.current[idx] = el;
                    }}
                    onClick={() => {
                      setSelectedIndex(idx);
                      playHit(hit);
                    }}
                    onDoubleClick={() => {
                      setSelectedIndex(idx);
                      setDetailOpen(true);
                    }}
                    className={`group flex cursor-pointer items-center justify-between gap-4 px-5 py-2.5 transition ${
                      isSelected
                        ? "bg-zinc-900/90 ring-1 ring-inset ring-amber-500/40"
                        : "hover:bg-zinc-900/40"
                    }`}
                  >
                    {/* Play button + Filename & Folder */}
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedIndex(idx);
                          playHit(hit);
                        }}
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition ${
                          isRowPlaying
                            ? "bg-amber-500 text-zinc-950"
                            : "bg-zinc-800 text-zinc-200 group-hover:bg-zinc-700"
                        }`}
                      >
                        {isRowPlaying ? (
                          <Pause className="h-4 w-4 fill-current" />
                        ) : (
                          <Play className="h-4 w-4 translate-x-0.5 fill-current" />
                        )}
                      </button>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-zinc-100">
                            {hit.filename}
                          </span>
                          {hit.user_tags.map((t) => (
                            <span
                              key={t}
                              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
                            >
                              #{t}
                            </span>
                          ))}
                        </div>
                        <div className="truncate text-xs text-zinc-500">
                          {hit.folder}
                        </div>
                      </div>
                    </div>

                    {/* Mini Waveform with best-offset marker */}
                    <MiniWaveform
                      fileId={hit.file_id}
                      durationS={hit.duration_s}
                      bestOffsetS={hit.best_offset_s}
                      bestEndS={hit.best_end_s}
                      currentTimeS={rowTime}
                      isPlaying={isRowPlaying}
                      onSeek={(timeS) => {
                        setSelectedIndex(idx);
                        playHit(hit, timeS);
                      }}
                    />

                    {/* Specs & Score breakdown on hover */}
                    <div className="flex w-52 shrink-0 items-center justify-end gap-3 text-right font-mono text-xs">
                      <div>
                        <div className="text-zinc-200">
                          {hit.duration_s.toFixed(2)}s
                        </div>
                        <div className="text-[10px] text-zinc-500">
                          {hit.format.split("/")[0].toUpperCase()} ·{" "}
                          {hit.best_offset_s > 0
                            ? `@${hit.best_offset_s.toFixed(1)}s`
                            : "0.0s"}
                        </div>
                      </div>

                      <div
                        className="rounded bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300"
                        title={`RRF: ${hit.rrf_score.toFixed(5)} | CLAP: ${
                          hit.clap_score !== null
                            ? hit.clap_score.toFixed(3)
                            : "-"
                        } | BM25: ${
                          hit.bm25_score !== null
                            ? hit.bm25_score.toFixed(2)
                            : "-"
                        }`}
                      >
                        <div className="text-amber-400">
                          {hit.clap_score !== null
                            ? `${(hit.clap_score * 100).toFixed(0)}%`
                            : hit.rrf_score.toFixed(3)}
                        </div>
                        <div className="hidden text-[9px] text-zinc-500 group-hover:block">
                          C:{hit.clap_score?.toFixed(2) ?? "-"} B:
                          {hit.bm25_score?.toFixed(1) ?? "-"}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={(e) => handleToggleFavoriteRow(e, hit)}
                        className={`rounded p-1.5 transition ${
                          hit.favorite
                            ? "text-rose-400"
                            : "text-zinc-600 hover:text-zinc-300"
                        }`}
                        title="Toggle favorite"
                      >
                        <Heart
                          className={`h-4 w-4 ${
                            hit.favorite ? "fill-current" : ""
                          }`}
                        />
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFindSimilarFile(hit.file_id);
                        }}
                        className="rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-amber-400"
                        title="Find similar sounds"
                      >
                        <Sparkles className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </main>

        {/* Detail Drawer */}
        {detailOpen && selectedHit && (
          <DetailPanel
            hit={selectedHit}
            onClose={() => setDetailOpen(false)}
            onFindSimilarFile={handleFindSimilarFile}
            onFindSimilarChunk={handleFindSimilarChunk}
            onUserUpdated={handleUserUpdated}
            onStopGlobalAudio={stopAudio}
          />
        )}
      </div>
    </div>
  );
};
