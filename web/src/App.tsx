import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Clock,
  Filter,
  FolderOpen,
  FolderPlus,
  Heart,
  History,
  PanelRight,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Rows3,
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
  revealInExplorer,
  searchSounds,
  updateUserData,
} from "./api";
import { DetailPanel } from "./components/DetailPanel";
import { DsSelect } from "./components/DsSelect";
import { LibraryModal } from "./components/LibraryModal";
import { MiniWaveform } from "./components/MiniWaveform";
import { SpectrumMeter } from "./components/SpectrumMeter";
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
const LS_DENSITY_KEY = "sfxsearch_density_v1";

function extractQueryTokens(q: string): string[] {
  const tokens: string[] = [];
  const rx =
    /\b(?:dur:[<>]?=?\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?|loop:(?:true|false|\d+(?:\.\d+)?)|(?:fmt|format):[a-zA-Z0-9_.-]+|fav(?:orite)?s?:(?:true|1|yes)|tag:[a-zA-Z0-9_.-]+)\b|(?:^|\s)-[a-zA-Z0-9_]+\b/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(q)) !== null) {
    tokens.push(m[0].trim());
  }
  return tokens.slice(0, 4);
}

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
  const [compactDensity, setCompactDensity] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_DENSITY_KEY) === "compact";
    } catch {
      return false;
    }
  });
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
  const [detailOpen, setDetailOpen] = useState<boolean>(true);

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

  useEffect(() => {
    if (compactDensity) {
      document.documentElement.setAttribute("data-density", "compact");
    } else {
      document.documentElement.removeAttribute("data-density");
    }
    try {
      localStorage.setItem(LS_DENSITY_KEY, compactDensity ? "compact" : "spacious");
    } catch {
      // ignore
    }
  }, [compactDensity]);

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

  // Smooth 60fps playhead tracking while audio is actively playing
  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    let rafId = 0;
    const tick = () => {
      if (audioRef.current && !audioRef.current.paused) {
        setCurrentTimeS(audioRef.current.currentTime);
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [isPlaying]);

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
      } else if (
        (e.key === "r" || e.key === "R") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
        const currentHit = results[selectedIndex];
        if (currentHit) {
          revealInExplorer(currentHit.file_id).catch(() => {});
          setStatusLabel(`Revealed '${currentHit.filename}' in Explorer`);
        }
      } else if (
        (e.key === "f" || e.key === "F") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
        const currentHit = results[selectedIndex];
        if (currentHit) {
          updateUserData(currentHit.file_id, {
            favorite: !currentHit.favorite,
          })
            .then((updated) => {
              handleUserUpdated(
                currentHit.file_id,
                updated.favorite,
                updated.user_tags,
                updated.note
              );
            })
            .catch(() => {});
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

  const handleRevealRow = async (e: React.MouseEvent, hit: SearchHit) => {
    e.stopPropagation();
    try {
      await revealInExplorer(hit.file_id);
      setStatusLabel(`Revealed '${hit.filename}' in Explorer`);
    } catch {
      setStatusLabel(`Could not reveal '${hit.filename}'`);
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
  const playingHit = results.find((r) => r.file_id === playingFileId) || null;

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

      {/* Top Transport & Search Header */}
      <header className="sfx-toolbar">
        <div className="sfx-toolbar-row">
          {/* Brand */}
          <div className="sfx-brand">
            <div className="sfx-brand-mark">
              <Volume2 size={16} />
            </div>
            <div>
              <div className="sfx-brand-title">sfx-search</div>
              <div className="sfx-brand-sub">CLAP · LanceDB</div>
            </div>
          </div>

          {/* Digital Transport Readout + Live 16-Band Spectrum */}
          <div className="sfx-readout" aria-label="Library and playback readout">
            <div className="sfx-readout-cell">
              <span className="sfx-readout-cap">Sounds</span>
              <span className="sfx-readout-val accent">
                {stats ? stats.ok_files.toLocaleString() : "0"}
              </span>
            </div>
            <div className="sfx-readout-cell">
              <span className="sfx-readout-cap">Playhead</span>
              <span className="sfx-readout-val warm">
                {isPlaying && playingHit
                  ? `${currentTimeS.toFixed(2)}s / ${playingHit.duration_s.toFixed(
                      1
                    )}s`
                  : selectedHit
                  ? `@${selectedHit.best_offset_s.toFixed(1)}s`
                  : "0.00s"}
              </span>
            </div>
            <SpectrumMeter
              audioElement={audioRef.current}
              isPlaying={isPlaying}
            />
          </div>

          {/* Search bar + mode selector + filters */}
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
                      ? 'Describe sound ("slow wooden floor creak, large empty house") or dur:2-8 -voice'
                      : "Search unlocks once your first sound file is indexed"
                  }
                  className="ds-input"
                />
                {extractQueryTokens(query).map((tok) => (
                  <span
                    key={tok}
                    className="ds-badge ds-badge-accent ds-tnum"
                    style={{ flexShrink: 0 }}
                    title="Active inline query filter"
                  >
                    {tok}
                  </span>
                ))}
                {history.length > 0 && hasIndexedFiles && (
                  <button
                    type="button"
                    onClick={() => setShowHistory((prev) => !prev)}
                    className="sfx-icon-btn"
                    title="Recent queries & syntax helpers"
                  >
                    <History size={13} />
                  </button>
                )}
              </div>

              {showHistory && hasIndexedFiles && (
                <div
                  className="ds-menu"
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: "calc(100% + 4px)",
                    zIndex: 50,
                  }}
                >
                  <div className="ds-menu-header">Quick syntax operators</div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                      padding: "4px 10px 8px",
                    }}
                  >
                    {[
                      { token: "dur:0-2", desc: "Short (<2s)" },
                      { token: "dur:5-30", desc: "Long (5–30s)" },
                      { token: "loop:true", desc: "Seamless loop" },
                      { token: "fmt:wav", desc: "WAV only" },
                      { token: "-voice", desc: "Exclude term" },
                    ].map((op) => (
                      <button
                        key={op.token}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          const nextQ = `${query.trim()} ${op.token}`.trim();
                          setQuery(nextQ);
                          searchInputRef.current?.focus();
                        }}
                        className="ds-badge ds-badge-neutral"
                        style={{
                          cursor: "pointer",
                          border: "var(--border-width) solid var(--border-subtle)",
                        }}
                        title={op.desc}
                      >
                        {op.token}
                      </button>
                    ))}
                  </div>
                  {history.length > 0 && (
                    <>
                      <div className="ds-menu-sep" />
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
                    </>
                  )}
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

            <div className="sfx-divider-v" />

            <label
              className={`ds-btn ds-btn-secondary ds-btn-sm ${
                !hasIndexedFiles ? "disabled" : ""
              }`}
              style={{
                pointerEvents: hasIndexedFiles ? "auto" : "none",
                opacity: hasIndexedFiles ? 1 : 0.5,
              }}
              title="Upload or drop a reference audio file to find similar sounds"
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
              title="Configure scanned library folders"
            >
              <FolderOpen size={14} />
              Folders ({roots.length})
            </button>

            <button
              type="button"
              onClick={() => setCompactDensity((prev) => !prev)}
              className={`sfx-icon-btn ${compactDensity ? "fav-active" : ""}`}
              style={{
                color: compactDensity ? "var(--primary-400)" : undefined,
              }}
              title={
                compactDensity
                  ? "Switch to spacious density"
                  : "Switch to compact density"
              }
            >
              <Rows3 size={15} />
            </button>

            {hasIndexedFiles && (
              <button
                type="button"
                onClick={() => setDetailOpen((prev) => !prev)}
                className="sfx-icon-btn"
                style={{
                  color: detailOpen ? "var(--primary-400)" : undefined,
                }}
                title={detailOpen ? "Hide inspector" : "Show inspector"}
              >
                <PanelRight size={15} />
              </button>
            )}
          </div>
        </div>

        {/* Collapsible Filter Drawer */}
        {showFilters && hasIndexedFiles && (
          <div className="sfx-filter-drawer">
            <div className="sfx-filter-grid">
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
            </div>

            <div className="sfx-filter-actions">
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
          {/* Sticky Column Header when files exist */}
          {hasIndexedFiles && (
            <div className="sfx-list-head">
              <span />
              <span>Sound / Folder</span>
              <span className="col-wave">Waveform &amp; Best Match Window</span>
              <span className="col-specs" style={{ textAlign: "right" }}>
                Specs
              </span>
              <span className="col-match" style={{ textAlign: "right" }}>
                Match
              </span>
              <span style={{ textAlign: "right" }}>Actions</span>
            </div>
          )}

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
                <div style={{ width: 540, maxWidth: "100%" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      paddingBottom: "var(--space-3)",
                      marginBottom: "var(--space-4)",
                      borderBottom: "var(--border-width) solid var(--border-subtle)",
                    }}
                  >
                    <span className="ds-panel-title">Library setup</span>
                    {isIndexing && (
                      <span className="ds-badge ds-badge-accent">
                        Scanning
                      </span>
                    )}
                  </div>
                  <div>
                    <div style={{ marginBottom: "var(--space-5)" }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "var(--space-2)",
                          marginBottom: "var(--space-2)",
                        }}
                      >
                        {isIndexing ? (
                          <span className="ds-spinner" />
                        ) : (
                          <FolderPlus
                            size={18}
                            style={{ color: "var(--primary-400)" }}
                          />
                        )}
                        <div className="ds-empty-title">
                          {roots.length === 0
                            ? "Add your sound-effects folders"
                            : "Indexing your first audio files"}
                        </div>
                      </div>
                      <div
                        className="ds-empty-desc"
                        style={{ maxWidth: "none", textAlign: "left" }}
                      >
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
                const scoreBarPct =
                  hit.clap_score !== null
                    ? Math.min(100, Math.max(8, Math.round(hit.clap_score * 100)))
                    : Math.min(100, Math.max(12, Math.round(hit.rrf_score * 1800)));

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
                    style={
                      {
                        "--row-idx": Math.min(idx, 10),
                      } as React.CSSProperties
                    }
                    className={`sfx-row ${isSelected ? "selected" : ""} ${
                      isRowPlaying ? "is-playing" : ""
                    }`}
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
                        <span className="sfx-row-filename" title={hit.filename}>
                          {hit.filename}
                        </span>
                        {hit.user_tags.map((t) => (
                          <span key={t} className="ds-badge ds-badge-accent">
                            {t}
                          </span>
                        ))}
                      </div>
                      <div className="sfx-row-folder" title={hit.folder}>
                        {hit.folder}
                      </div>
                    </div>

                    <div className="sfx-row-wave">
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
                    </div>

                    <div className="sfx-row-specs">
                      <span className="sfx-row-dur">
                        {hit.duration_s.toFixed(2)}s
                      </span>
                      <span className="sfx-row-subspec">
                        {hit.format.split("/")[0].toUpperCase()} ·{" "}
                        {(hit.sample_rate / 1000).toFixed(0)}k ·{" "}
                        {hit.lufs_integrated !== null
                          ? `${hit.lufs_integrated.toFixed(0)} LUFS`
                          : `${hit.channels}ch`}
                      </span>
                    </div>

                    <div
                      className="sfx-row-score"
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
                      <span
                        style={{
                          fontSize: "var(--font-size-xs)",
                          fontWeight: 500,
                          color:
                            hit.clap_score !== null && hit.clap_score > 0.25
                              ? "var(--primary-400)"
                              : "var(--text-secondary)",
                        }}
                      >
                        {hit.clap_score !== null
                          ? `${(hit.clap_score * 100).toFixed(0)}%`
                          : hit.rrf_score.toFixed(3)}
                      </span>
                      <div className="sfx-score-bar-track">
                        <div
                          className="sfx-score-bar-fill"
                          style={{ width: `${scoreBarPct}%` }}
                        />
                      </div>
                    </div>

                    <div className="sfx-row-actions">
                      <button
                        type="button"
                        onClick={(e) => handleRevealRow(e, hit)}
                        className="sfx-icon-btn sfx-reveal-btn"
                        aria-label="Reveal file in Explorer"
                        title="Reveal file in Explorer (R)"
                      >
                        <FolderOpen size={14} />
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFindSimilarFile(hit.file_id);
                        }}
                        className="sfx-icon-btn"
                        aria-label="Find similar sounds"
                        title="Find similar sounds"
                      >
                        <Sparkles size={14} />
                      </button>

                      <button
                        type="button"
                        onClick={(e) => handleToggleFavoriteRow(e, hit)}
                        className={`sfx-icon-btn ${
                          hit.favorite ? "fav-active" : ""
                        }`}
                        aria-label={
                          hit.favorite
                            ? "Remove from favorites"
                            : "Add to favorites"
                        }
                        title="Toggle favorite (F)"
                      >
                        <Heart
                          size={14}
                          fill={hit.favorite ? "currentColor" : "none"}
                        />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Bottom Footer Status Bar */}
          <footer className="sfx-statusbar">
            <span className="ds-tnum">
              {statusLabel ||
                (hasIndexedFiles
                  ? `${results.length} result${
                      results.length === 1 ? "" : "s"
                    }${
                      stats
                        ? ` · ${stats.ok_files.toLocaleString()} files indexed`
                        : ""
                    }`
                  : roots.length === 0
                  ? "No library folders configured"
                  : "Indexing initial audio files...")}
            </span>
            <span className="sfx-statusbar-shortcuts">
              <kbd className="sfx-kbd">↑</kbd> <kbd className="sfx-kbd">↓</kbd>{" "}
              navigate · <kbd className="sfx-kbd">Space</kbd> play/pause ·{" "}
              <kbd className="sfx-kbd">R</kbd> reveal ·{" "}
              <kbd className="sfx-kbd">F</kbd> favorite ·{" "}
              <kbd className="sfx-kbd">Enter</kbd> inspector ·{" "}
              <kbd className="sfx-kbd">/</kbd> search
            </span>
          </footer>
        </main>

        {/* Right Inspector Drawer */}
        {detailOpen && selectedHit && (
          <>
            <div
              className="sfx-inspector-backdrop"
              onClick={() => setDetailOpen(false)}
              aria-hidden="true"
            />
            <DetailPanel
              hit={selectedHit}
              onClose={() => setDetailOpen(false)}
              onFindSimilarFile={handleFindSimilarFile}
              onFindSimilarChunk={handleFindSimilarChunk}
              onUserUpdated={handleUserUpdated}
              onStopGlobalAudio={stopAudio}
            />
          </>
        )}
      </div>
    </div>
  );
};
