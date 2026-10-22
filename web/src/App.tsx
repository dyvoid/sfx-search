import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Clock,
  Filter,
  FolderOpen,
  FolderPlus,
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
  addLibraryRoot,
  fetchAvailableFilters,
  fetchLibraryState,
  findSimilarById,
  findSimilarByUpload,
  pickNativeFolder,
  removeLibraryRoot,
  rescanLibrary,
  searchSounds,
  updateUserData,
} from "./api";
import { DetailPanel } from "./components/DetailPanel";
import { DsSelect } from "./components/DsSelect";
import { LibraryModal } from "./components/LibraryModal";
import { MiniWaveform } from "./components/MiniWaveform";
import {
  AvailableFilters,
  DEFAULT_FILTERS,
  FilterState,
  IndexingProgress,
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

  const [roots, setRoots] = useState<string[]>([]);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [indexing, setIndexing] = useState<IndexingProgress | null>(null);
  const [availFilters, setAvailFilters] = useState<AvailableFilters | null>(null);
  const [libraryModalOpen, setLibraryModalOpen] = useState<boolean>(false);

  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [statusLabel, setStatusLabel] = useState<string>("");

  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [detailOpen, setDetailOpen] = useState<boolean>(false);

  const [playingFileId, setPlayingFileId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTimeS, setCurrentTimeS] = useState<number>(0);
  const [startAtBestOffset, setStartAtBestOffset] = useState<boolean>(true);
  const [loopEnabled, setLoopEnabled] = useState<boolean>(false);

  const [isDraggingFile, setIsDraggingFile] = useState<boolean>(false);
  const [onboardingInput, setOnboardingInput] = useState<string>("");
  const [onboardingError, setOnboardingError] = useState<string>("");
  const [onboardingBusy, setOnboardingBusy] = useState<boolean>(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const prevOkFilesRef = useRef<number>(0);

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
    async (
      qOverride?: string,
      modeOverride?: SearchMode,
      filtersOverride?: FilterState
    ) => {
      const q = qOverride !== undefined ? qOverride : query;
      const m = modeOverride !== undefined ? modeOverride : mode;
      const f = filtersOverride !== undefined ? filtersOverride : filters;

      const effectiveMode: SearchMode = !q.trim() ? "keyword_only" : m;
      setLoading(true);
      setStatusLabel("");
      try {
        const hits = await searchSounds(q, effectiveMode, f, 50);
        setResults(hits);
        setSelectedIndex((prev) =>
          hits.length > 0 ? Math.min(prev, hits.length - 1) : 0
        );
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

  const refreshLibraryState = useCallback(async () => {
    try {
      const lib = await fetchLibraryState();
      setRoots(lib.roots);
      setStats(lib.stats);
      setIndexing(lib.indexing);

      const prevOk = prevOkFilesRef.current;
      const nextOk = lib.stats.ok_files;
      prevOkFilesRef.current = nextOk;

      if (nextOk > 0 && (prevOk === 0 || nextOk !== prevOk)) {
        fetchAvailableFilters().then(setAvailFilters).catch(() => {});
        runSearch();
      } else if (nextOk === 0) {
        setResults([]);
      }
    } catch {
      // ignore transient poll errors
    }
  }, [runSearch]);

  useEffect(() => {
    refreshLibraryState();
    fetchAvailableFilters().then(setAvailFilters).catch(() => {});
  }, []);

  // Poll while background indexing is running (or when roots exist but 0 files indexed yet)
  useEffect(() => {
    const isRunning = indexing?.state === "running";
    if (!isRunning) {
      return;
    }
    const timer = window.setInterval(() => {
      refreshLibraryState();
    }, 1200);
    return () => window.clearInterval(timer);
  }, [indexing?.state, refreshLibraryState]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_FILTERS_KEY, JSON.stringify(filters));
    } catch {
      // ignore
    }
  }, [filters]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.loop = loopEnabled;
    }
  }, [loopEnabled]);

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

  // Keyboard navigation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (libraryModalOpen) {
        if (e.key === "Escape") {
          setLibraryModalOpen(false);
        }
        return;
      }

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
  }, [results, selectedIndex, playHit, libraryModalOpen]);

  const handleAddRoot = async (path: string) => {
    const res = await addLibraryRoot(path);
    setRoots(res.roots);
    setIndexing(res.indexing);
    await refreshLibraryState();
  };

  const handleBrowseAndAddRoot = async () => {
    const picked = await pickNativeFolder();
    if (picked) {
      await handleAddRoot(picked);
    }
  };

  const handleRemoveRoot = async (path: string) => {
    const res = await removeLibraryRoot(path, true);
    setRoots(res.roots);
    setStats(res.stats);
    setIndexing(res.indexing);
    prevOkFilesRef.current = res.stats.ok_files;
    if (res.stats.ok_files === 0) {
      setResults([]);
    } else {
      runSearch();
    }
  };

  const handleRescan = async (reindex: boolean) => {
    const res = await rescanLibrary(reindex);
    setRoots(res.roots);
    setIndexing(res.indexing);
  };

  const handleOnboardingSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = onboardingInput.trim();
    if (!clean) {
      return;
    }
    setOnboardingBusy(true);
    setOnboardingError("");
    try {
      await handleAddRoot(clean);
      setOnboardingInput("");
    } catch (err) {
      setOnboardingError(
        err instanceof Error ? err.message : "Failed to add folder"
      );
    } finally {
      setOnboardingBusy(false);
    }
  };

  const handleFindSimilarFile = async (fileId: string) => {
    setLoading(true);
    try {
      const hits = await findSimilarById(fileId, undefined, 40);
      setResults(hits);
      setSelectedIndex(0);
      setStatusLabel(`Similar to ${fileId.slice(0, 8)}`);
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
      setStatusLabel(`Similar to ${fileId.slice(0, 8)} · chunk #${chunkIdx}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDropFile = async (file: File) => {
    setLoading(true);
    setStatusLabel(`Embedding reference '${file.name}'`);
    try {
      const hits = await findSimilarByUpload(file, 40);
      setResults(hits);
      setSelectedIndex(0);
      setStatusLabel(`Similar to '${file.name}'`);
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

  const hasIndexedFiles = (stats?.ok_files || 0) > 0;
  const isIndexing = indexing?.state === "running";
  const doneFiles = (indexing?.indexed_ok || 0) + (indexing?.indexed_errors || 0);
  const totalToIndex = indexing?.to_index_count || 0;
  const progressPct =
    totalToIndex > 0
      ? Math.min(100, Math.round((doneFiles / totalToIndex) * 100))
      : 0;
  const selectedHit = results[selectedIndex] || null;

  return (
    <div
      className="sfx-shell"
      onDragOver={(e) => {
        e.preventDefault();
        if (hasIndexedFiles) {
          setIsDraggingFile(true);
        }
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
        if (f && hasIndexedFiles) {
          handleDropFile(f);
        }
      }}
    >
      {/* Shared HTML5 audio element */}
      <audio
        ref={audioRef}
        onTimeUpdate={(e) => setCurrentTimeS(e.currentTarget.currentTime)}
        onEnded={() => setIsPlaying(false)}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
      />

      {/* Drag & drop reference overlay */}
      {isDraggingFile && (
        <div className="ds-scrim">
          <div className="ds-dialog" style={{ width: 440, textAlign: "center" }}>
            <div className="ds-dialog-body">
              <div className="ds-empty">
                <div className="ds-empty-icon">
                  <Upload size={20} />
                </div>
                <div className="ds-empty-title">Drop reference audio</div>
                <div className="ds-empty-desc">
                  Release any WAV, FLAC, AIFF, MP3, OGG, or M4A file to search
                  for acoustically similar sounds.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Library Folder Management Modal */}
      <LibraryModal
        open={libraryModalOpen}
        roots={roots}
        stats={stats}
        indexing={indexing}
        onClose={() => setLibraryModalOpen(false)}
        onAddRoot={handleAddRoot}
        onBrowseRoot={handleBrowseAndAddRoot}
        onRemoveRoot={handleRemoveRoot}
        onRescan={handleRescan}
      />

      {/* Top Toolbar */}
      <header className="sfx-toolbar">
        <div className="sfx-toolbar-row">
          {/* Brand */}
          <div className="sfx-brand">
            <div className="sfx-brand-mark">
              <Volume2 size={16} />
            </div>
            <div>
              <div className="sfx-brand-title">sfx-search</div>
              <div className="sfx-brand-meta">
                {stats && stats.ok_files > 0
                  ? `${stats.ok_files.toLocaleString()} files · ${stats.total_duration_hours.toFixed(
                      1
                    )}h · ${stats.total_chunks.toLocaleString()} chunks`
                  : roots.length > 0
                  ? `${roots.length} folder${roots.length === 1 ? "" : "s"} configured`
                  : "No library folders"}
              </div>
            </div>
          </div>

          {/* Search bar + mode tabs + filters */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setShowHistory(false);
              if (hasIndexedFiles) {
                runSearch();
              }
            }}
            className="sfx-search-form"
          >
            <div className="sfx-search-box-wrap">
              <div
                className="ds-input-box"
                style={{
                  opacity: hasIndexedFiles ? 1 : 0.55,
                  gap: "var(--space-2)",
                }}
              >
                <Search
                  size={14}
                  style={{ color: "var(--text-tertiary)", flexShrink: 0 }}
                />
                <input
                  ref={searchInputRef}
                  type="text"
                  disabled={!hasIndexedFiles}
                  value={query}
                  onFocus={() => setShowHistory(true)}
                  onBlur={() => setTimeout(() => setShowHistory(false), 180)}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    hasIndexedFiles
                      ? 'Search sounds ("slow wooden floor creak, large empty house") or dur:2-8 -voice'
                      : "Search becomes available once your first sound file is indexed"
                  }
                  className="ds-input"
                />
                {history.length > 0 && hasIndexedFiles && (
                  <button
                    type="button"
                    onClick={() => setShowHistory((prev) => !prev)}
                    className="sfx-icon-btn"
                    title="Recent queries"
                  >
                    <History size={13} />
                  </button>
                )}
              </div>

              {showHistory && history.length > 0 && hasIndexedFiles && (
                <div
                  className="ds-menu"
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: "calc(100% + 4px)",
                    zIndex: 40,
                  }}
                >
                  <div className="ds-menu-header">Recent queries</div>
                  {history.map((hItem) => (
                    <button
                      key={hItem}
                      type="button"
                      onMouseDown={() => {
                        setQuery(hItem);
                        setShowHistory(false);
                        runSearch(hItem);
                      }}
                      className="ds-menu-item"
                    >
                      <Clock size={13} />
                      <span className="l">{hItem}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <DsSelect
              disabled={!hasIndexedFiles}
              value={mode}
              width={160}
              ariaLabel="Search mode"
              options={[
                { value: "hybrid", label: "Hybrid (RRF)" },
                { value: "audio_only", label: "Audio (CLAP)" },
                { value: "keyword_only", label: "Keyword (BM25)" },
              ]}
              onChange={(val) => {
                const nextMode = val as SearchMode;
                setMode(nextMode);
                if (hasIndexedFiles) {
                  runSearch(query, nextMode, filters);
                }
              }}
            />

            <button
              type="submit"
              disabled={!hasIndexedFiles || loading}
              className="ds-btn ds-btn-primary"
            >
              {loading ? "Searching" : "Search"}
            </button>

            <button
              type="button"
              disabled={!hasIndexedFiles}
              onClick={() => setShowFilters((prev) => !prev)}
              className={`ds-btn ${
                showFilters ? "ds-btn-secondary" : "ds-btn-ghost"
              }`}
            >
              <Filter size={14} />
              Filters
            </button>
          </form>

          {/* Transport & Library Actions */}
          <div className="sfx-transport-controls">
            <label
              className="ds-switch-item"
              onClick={() => setStartAtBestOffset((prev) => !prev)}
              title="Start playback at best-matching 10s window offset"
            >
              <div className={`ds-switch-track ${startAtBestOffset ? "on" : ""}`}>
                <div className="ds-switch-thumb" />
              </div>
              <span
                className="ds-switch-label"
                style={{ fontSize: "var(--font-size-xs)" }}
              >
                Best offset
              </span>
            </label>

            <button
              type="button"
              onClick={() => setLoopEnabled((prev) => !prev)}
              className={`ds-btn ds-btn-sm ${
                loopEnabled ? "ds-btn-primary" : "ds-btn-ghost"
              }`}
              title="Loop playback"
            >
              <Repeat size={14} />
              Loop
            </button>

            <label
              className={`ds-btn ds-btn-secondary ds-btn-sm ${
                !hasIndexedFiles ? "disabled" : ""
              }`}
              style={{
                pointerEvents: hasIndexedFiles ? "auto" : "none",
                opacity: hasIndexedFiles ? 1 : 0.5,
              }}
            >
              <Upload size={14} />
              Match audio
              <input
                type="file"
                accept="audio/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    handleDropFile(f);
                  }
                }}
              />
            </label>

            <button
              type="button"
              onClick={() => setLibraryModalOpen(true)}
              className="ds-btn ds-btn-secondary ds-btn-sm"
            >
              <FolderOpen size={14} />
              Library ({roots.length})
            </button>
          </div>
        </div>

        {/* Collapsible Filter Drawer */}
        {showFilters && hasIndexedFiles && (
          <div className="sfx-filter-drawer">
            <div className="ds-input-field">
              <label className="ds-microlabel">Duration (s)</label>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div className="ds-input-box" style={{ width: 76 }}>
                  <input
                    type="number"
                    step="0.5"
                    placeholder="Min"
                    value={filters.minDuration}
                    onChange={(e) =>
                      setFilters({ ...filters, minDuration: e.target.value })
                    }
                    className="ds-input ds-tnum"
                  />
                </div>
                <span style={{ color: "var(--text-tertiary)" }}>–</span>
                <div className="ds-input-box" style={{ width: 76 }}>
                  <input
                    type="number"
                    step="0.5"
                    placeholder="Max"
                    value={filters.maxDuration}
                    onChange={(e) =>
                      setFilters({ ...filters, maxDuration: e.target.value })
                    }
                    className="ds-input ds-tnum"
                  />
                </div>
              </div>
            </div>

            <div className="ds-input-field">
              <label className="ds-microlabel">Loudness (LUFS)</label>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div className="ds-input-box" style={{ width: 76 }}>
                  <input
                    type="number"
                    step="1"
                    placeholder="-40"
                    value={filters.minLufs}
                    onChange={(e) =>
                      setFilters({ ...filters, minLufs: e.target.value })
                    }
                    className="ds-input ds-tnum"
                  />
                </div>
                <span style={{ color: "var(--text-tertiary)" }}>–</span>
                <div className="ds-input-box" style={{ width: 76 }}>
                  <input
                    type="number"
                    step="1"
                    placeholder="0"
                    value={filters.maxLufs}
                    onChange={(e) =>
                      setFilters({ ...filters, maxLufs: e.target.value })
                    }
                    className="ds-input ds-tnum"
                  />
                </div>
              </div>
            </div>

            <div className="ds-input-field">
              <label className="ds-microlabel">Format</label>
              <DsSelect
                value={filters.format}
                width={128}
                ariaLabel="Audio format"
                options={[
                  { value: "", label: "All formats" },
                  ...(
                    availFilters?.formats || ["wav", "flac", "mp3", "ogg", "aiff"]
                  ).map((fmt) => ({
                    value: fmt,
                    label: fmt.toUpperCase(),
                  })),
                ]}
                onChange={(val) => setFilters({ ...filters, format: val })}
              />
            </div>

            <div className="ds-input-field">
              <label className="ds-microlabel">Folder root</label>
              <DsSelect
                value={filters.root}
                width={190}
                ariaLabel="Folder root"
                options={[
                  { value: "", label: "All roots" },
                  ...(availFilters?.roots || []).map((rt) => ({
                    value: rt,
                    label: rt,
                  })),
                ]}
                onChange={(val) => setFilters({ ...filters, root: val })}
              />
            </div>

            <div className="ds-input-field">
              <label className="ds-microlabel">Min loop score</label>
              <div className="ds-input-box" style={{ width: 90 }}>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="1"
                  placeholder="0.0–1.0"
                  value={filters.minLoopScore}
                  onChange={(e) =>
                    setFilters({ ...filters, minLoopScore: e.target.value })
                  }
                  className="ds-input ds-tnum"
                />
              </div>
            </div>

            <div className="ds-input-field">
              <label className="ds-microlabel">User tag</label>
              <DsSelect
                value={filters.userTag}
                width={130}
                ariaLabel="User tag"
                options={[
                  { value: "", label: "Any tag" },
                  ...(availFilters?.user_tags || []).map((t) => ({
                    value: t,
                    label: `#${t}`,
                  })),
                ]}
                onChange={(val) => setFilters({ ...filters, userTag: val })}
              />
            </div>

            <label
              className="ds-check"
              style={{ height: "var(--control-height-md)" }}
              onClick={() =>
                setFilters({ ...filters, favoritesOnly: !filters.favoritesOnly })
              }
            >
              <div
                className={`ds-checkbox ${filters.favoritesOnly ? "on" : ""}`}
              >
                {filters.favoritesOnly && <div className="ds-checkbox-inner" />}
              </div>
              <span
                className="ds-check-label"
                style={{ fontSize: "var(--font-size-sm)" }}
              >
                Favorites only
              </span>
            </label>

            <button
              type="button"
              onClick={() => runSearch(query, mode, filters)}
              className="ds-btn ds-btn-primary ds-btn-sm"
            >
              Apply
            </button>

            <button
              type="button"
              onClick={() => {
                setFilters(DEFAULT_FILTERS);
                runSearch(query, mode, DEFAULT_FILTERS);
              }}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              <RotateCcw size={13} />
              Reset
            </button>
          </div>
        )}
      </header>

      {/* Background Indexing Progress Banner */}
      {isIndexing && indexing && (
        <div className="sfx-index-banner">
          <span className="ds-spinner" style={{ width: 14, height: 14 }} />
          <div style={{ flex: 1 }}>
            <div className="ds-progress-row">
              <div className="ds-progress-label">
                <span style={{ color: "var(--text-primary)" }}>
                  Scanning library in background:{" "}
                  <strong className="ds-tnum">
                    {doneFiles} / {totalToIndex || "scanning..."}
                  </strong>{" "}
                  files indexed
                  {hasIndexedFiles
                    ? " — search is live while indexing continues"
                    : " — search unlocks as soon as the first file finishes"}
                </span>
                <span className="ds-progress-pct ds-tnum">
                  {indexing.files_per_min > 0
                    ? `${indexing.files_per_min.toFixed(0)} files/min · ETA ${indexing.eta_seconds.toFixed(
                        0
                      )}s · `
                    : ""}
                  {progressPct}%
                </span>
              </div>
              <div className="ds-progress-track">
                <div
                  className="ds-progress-fill"
                  style={{ width: `${Math.max(3, progressPct)}%` }}
                />
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLibraryModalOpen(true)}
            className="ds-btn ds-btn-ghost ds-btn-sm"
          >
            Details
          </button>
        </div>
      )}

      {/* Main Workspace */}
      <div className="sfx-workspace">
        <main className="sfx-main">
          {/* Status bar */}
          <div className="sfx-statusbar">
            <span className="ds-tnum">
              {statusLabel ||
                (hasIndexedFiles
                  ? `${results.length} result${results.length === 1 ? "" : "s"}`
                  : roots.length === 0
                  ? "Awaiting library folder selection"
                  : "Indexing initial audio files...")}
            </span>
            <span>
              <kbd className="sfx-kbd">↑</kbd> <kbd className="sfx-kbd">↓</kbd>{" "}
              navigate · <kbd className="sfx-kbd">Space</kbd> play/pause ·{" "}
              <kbd className="sfx-kbd">Enter</kbd> inspector ·{" "}
              <kbd className="sfx-kbd">/</kbd> search
            </span>
          </div>

          {/* Content: Onboarding Empty State vs Results List */}
          <div className="sfx-results-list ds-scroll">
            {!hasIndexedFiles ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minHeight: "100%",
                  padding: "var(--space-8)",
                }}
              >
                <div
                  className="ds-panel"
                  style={{ width: 520, maxWidth: "100%" }}
                >
                  <div className="ds-panel-head">
                    <span className="ds-panel-title">Library setup</span>
                    {isIndexing && (
                      <span className="ds-badge ds-badge-accent">
                        Scanning
                      </span>
                    )}
                  </div>
                  <div className="ds-panel-body">
                    <div
                      className="ds-empty"
                      style={{ padding: "var(--space-4) 0 var(--space-5)" }}
                    >
                      <div className="ds-empty-icon">
                        {isIndexing ? (
                          <span className="ds-spinner" />
                        ) : (
                          <FolderPlus size={20} />
                        )}
                      </div>
                      <div className="ds-empty-title">
                        {roots.length === 0
                          ? "Add your sound-effects folders"
                          : "Indexing your first audio files"}
                      </div>
                      <div className="ds-empty-desc">
                        {roots.length === 0
                          ? "Define one or more folders containing your audio library. Files are decoded and embedded in the background, and search becomes available as soon as the first sound is indexed."
                          : `Scanning ${roots.join(
                              ", "
                            )}. Search will activate automatically once the first file completes.`}
                      </div>
                    </div>

                    <form
                      onSubmit={handleOnboardingSubmit}
                      className="ds-input-field"
                    >
                      <label className="ds-input-label">Folder path</label>
                      <div style={{ display: "flex", gap: "var(--space-2)" }}>
                        <div
                          className={`ds-input-box ${
                            onboardingError ? "error" : ""
                          }`}
                          style={{ flex: 1 }}
                        >
                          <input
                            type="text"
                            value={onboardingInput}
                            onChange={(e) => {
                              setOnboardingInput(e.target.value);
                              setOnboardingError("");
                            }}
                            placeholder="D:/SFX or C:/Projects/Audio"
                            className="ds-input"
                            style={{ fontFamily: "var(--font-mono)" }}
                          />
                        </div>
                        <button
                          type="submit"
                          disabled={onboardingBusy || !onboardingInput.trim()}
                          className="ds-btn ds-btn-primary"
                        >
                          <FolderPlus size={14} />
                          Add folder
                        </button>
                        <button
                          type="button"
                          disabled={onboardingBusy}
                          onClick={handleBrowseAndAddRoot}
                          className="ds-btn ds-btn-secondary"
                        >
                          <FolderOpen size={14} />
                          Browse
                        </button>
                      </div>
                      {onboardingError && (
                        <span className="ds-input-error">{onboardingError}</span>
                      )}
                    </form>

                    {roots.length > 0 && (
                      <div style={{ marginTop: "var(--space-4)" }}>
                        <div
                          className="ds-microlabel"
                          style={{ marginBottom: "var(--space-2)" }}
                        >
                          Active folders
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "var(--space-2)",
                          }}
                        >
                          {roots.map((r) => (
                            <span key={r} className="ds-badge ds-badge-neutral">
                              {r}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : results.length === 0 && !loading ? (
              <div className="ds-empty" style={{ marginTop: "var(--space-10)" }}>
                <div className="ds-empty-icon">
                  <Search size={20} />
                </div>
                <div className="ds-empty-title">No matching sounds</div>
                <div className="ds-empty-desc">
                  Adjust your query, switch search mode, or clear active
                  filters.
                </div>
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
                    className={`sfx-row ${isSelected ? "selected" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedIndex(idx);
                        playHit(hit);
                      }}
                      className={`sfx-play-btn ${
                        isRowPlaying ? "playing" : ""
                      }`}
                      aria-label={isRowPlaying ? "Pause" : "Play"}
                    >
                      {isRowPlaying ? (
                        <Pause size={14} />
                      ) : (
                        <Play size={14} />
                      )}
                    </button>

                    <div className="sfx-row-info">
                      <div className="sfx-row-title-line">
                        <span className="sfx-row-filename">{hit.filename}</span>
                        {hit.user_tags.map((t) => (
                          <span key={t} className="ds-badge ds-badge-accent">
                            {t}
                          </span>
                        ))}
                      </div>
                      <div className="sfx-row-folder">{hit.folder}</div>
                    </div>

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

                    <div className="sfx-row-metrics">
                      <div style={{ textAlign: "right" }}>
                        <div
                          style={{
                            fontSize: "var(--font-size-xs)",
                            color: "var(--text-primary)",
                          }}
                        >
                          {hit.duration_s.toFixed(2)}s
                        </div>
                        <div
                          style={{
                            fontSize: "var(--font-size-2xs)",
                            color: "var(--text-tertiary)",
                          }}
                        >
                          {hit.format.split("/")[0].toUpperCase()} ·{" "}
                          {hit.best_offset_s > 0
                            ? `@${hit.best_offset_s.toFixed(1)}s`
                            : "0.0s"}
                        </div>
                      </div>

                      <span
                        className="ds-badge ds-badge-neutral ds-tnum"
                        title={`RRF: ${hit.rrf_score.toFixed(5)} | CLAP: ${
                          hit.clap_score !== null
                            ? hit.clap_score.toFixed(3)
                            : "—"
                        } | BM25: ${
                          hit.bm25_score !== null
                            ? hit.bm25_score.toFixed(2)
                            : "—"
                        }`}
                      >
                        {hit.clap_score !== null
                          ? `${(hit.clap_score * 100).toFixed(0)}%`
                          : hit.rrf_score.toFixed(3)}
                      </span>

                      <button
                        type="button"
                        onClick={(e) => handleToggleFavoriteRow(e, hit)}
                        className={`sfx-icon-btn ${
                          hit.favorite ? "fav-active" : ""
                        }`}
                        title="Toggle favorite"
                      >
                        <Heart
                          size={14}
                          fill={hit.favorite ? "currentColor" : "none"}
                        />
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFindSimilarFile(hit.file_id);
                        }}
                        className="sfx-icon-btn"
                        title="Find similar sounds"
                      >
                        <Sparkles size={14} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </main>

        {/* Inspector Drawer */}
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
