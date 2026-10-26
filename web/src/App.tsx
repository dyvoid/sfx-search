import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  Clock,
  Filter,
  FolderOpen,
  FolderPlus,
  Heart,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Rows3,
  Search,
  Sliders,
  Sparkles,
  Upload,
  Volume2,
  X,
} from "lucide-react";
import {
  addLibraryRoot,
  fetchAvailableFilters,
  fetchFolders,
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
import { FolderTree } from "./components/FolderTree";
import { LibraryModal } from "./components/LibraryModal";
import { MiniWaveform } from "./components/MiniWaveform";
import { SpectrumMeter } from "./components/SpectrumMeter";
import { StudioView } from "./editor/StudioView";
import {
  AvailableFilters,
  DEFAULT_FILTERS,
  FilterState,
  FolderEntry,
  IndexingProgress,
  LibraryStats,
  SearchHit,
  SearchMode,
  SortMode,
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

const PAGE_SIZE = 50;

function formatQuietFolder(folder: string, root: string): string {
  const normFolder = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  const normRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (
    normRoot &&
    normFolder.toLowerCase().startsWith(normRoot.toLowerCase())
  ) {
    const rel = normFolder.slice(normRoot.length).replace(/^\/+/, "");
    if (rel) {
      return rel;
    }
  }
  const parts = normFolder.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return normFolder;
  }
  return parts.slice(-2).join(" / ");
}

const BROWSER_NATIVE_EXTS = new Set([
  ".mp3",
  ".ogg",
  ".opus",
  ".m4a",
  ".aac",
  ".flac",
]);

// Mirrors _needs_transcode() and the MIME table in api_stream_audio so the
// drag payload advertises the filename/type /api/audio actually serves —
// transcoded sources leave the backend as WAV regardless of on-disk format.
function audioDragPayload(hit: SearchHit): { filename: string; mime: string } {
  const ext = (hit.path.match(/\.[^.\\/]+$/)?.[0] || "").toLowerCase();
  const fmt = (hit.format || "").toLowerCase();
  const ch = hit.channels || 1;
  let transcoded: boolean;
  if (ext === ".aif" || ext === ".aiff" || ext === ".wma") {
    transcoded = true;
  } else if (ext === ".wav") {
    transcoded =
      ch > 2 ||
      fmt.includes("pcm_s24") ||
      fmt.includes("pcm_s32") ||
      fmt.includes("pcm_f64") ||
      fmt.includes("adpcm");
  } else if (BROWSER_NATIVE_EXTS.has(ext)) {
    transcoded = ch > 2;
  } else {
    transcoded = true;
  }
  if (transcoded) {
    return {
      filename: `${hit.filename.replace(/\.[^.]+$/, "")}.wav`,
      mime: "audio/wav",
    };
  }
  const mimeByExt: Record<string, string> = {
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/mp4",
  };
  return {
    filename: hit.filename,
    mime: mimeByExt[ext] || "application/octet-stream",
  };
}

const DRAG_FILE_MAX_SECONDS = 120;
const DRAG_FILE_CACHE_MAX_ENTRIES = 32;
const DRAG_FILE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const dragFileCache = new Map<string, File>();
const dragFileInflight = new Set<string>();

function audioUrlFor(hit: SearchHit): string {
  // Trailing filename segment is ignored by the backend but makes URL drops
  // carry a real name/extension to receivers that derive both from the URL.
  const { filename } = audioDragPayload(hit);
  return `${window.location.origin}/api/audio/${encodeURIComponent(
    hit.file_id
  )}/${encodeURIComponent(filename)}`;
}

// Page-to-page drops only deliver a real File when one is attached via
// items.add() during dragstart — DownloadURL and uri-list payloads never
// materialize as dataTransfer.files on the receiving page. Bytes therefore
// must be in hand before the drag begins: prefetched on row press, with the
// sync fetch below as last resort.
function prefetchDragFile(hit: SearchHit): void {
  if (
    hit.duration_s > DRAG_FILE_MAX_SECONDS ||
    dragFileCache.has(hit.file_id) ||
    dragFileInflight.has(hit.file_id)
  ) {
    return;
  }
  const { filename, mime } = audioDragPayload(hit);
  dragFileInflight.add(hit.file_id);
  void fetch(audioUrlFor(hit))
    .then((res) => (res.ok ? res.blob() : Promise.reject(res)))
    .then((blob) => {
      if (blob.size > DRAG_FILE_CACHE_MAX_BYTES) {
        return;
      }
      if (dragFileCache.size >= DRAG_FILE_CACHE_MAX_ENTRIES) {
        const oldest = dragFileCache.keys().next().value;
        if (oldest !== undefined) {
          dragFileCache.delete(oldest);
        }
      }
      dragFileCache.set(hit.file_id, new File([blob], filename, { type: mime }));
    })
    .catch(() => {})
    .finally(() => dragFileInflight.delete(hit.file_id));
}

// items.add() must run before dragstart returns, so when the prefetch hasn't
// landed yet a synchronous XHR is the only way to still get the bytes. Sync
// XHR forbids responseType on window globals; x-user-defined keeps raw bytes.
function fetchDragFileSync(hit: SearchHit): File | null {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", audioUrlFor(hit), false);
    xhr.overrideMimeType("text/plain; charset=x-user-defined");
    xhr.send();
    if (xhr.status < 200 || xhr.status >= 300) {
      return null;
    }
    const text = xhr.responseText;
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      bytes[i] = text.charCodeAt(i) & 0xff;
    }
    const { filename, mime } = audioDragPayload(hit);
    return new File([bytes], filename, { type: mime });
  } catch {
    return null;
  }
}

function handleRowDragStart(e: React.DragEvent, hit: SearchHit) {
  const { filename, mime } = audioDragPayload(hit);
  const url = audioUrlFor(hit);
  const dt = e.dataTransfer;
  dt.effectAllowed = "copy";

  let fileAttached = false;
  if (hit.duration_s <= DRAG_FILE_MAX_SECONDS) {
    const file = dragFileCache.get(hit.file_id) ?? fetchDragFileSync(hit);
    if (file) {
      try {
        dt.items.add(file);
        fileAttached = true;
      } catch {
        // items.add(File) unsupported — URL payloads below still apply
      }
    }
  }
  if (!fileAttached) {
    // Chromium-only DownloadURL ("mime:name:url") exposes the drag as a real
    // file to desktop apps, streamed from the audio endpoint on drop.
    dt.setData(
      "DownloadURL",
      `${mime}:${filename.replace(/:/g, "_")}:${url}`
    );
  }
  dt.setData("text/uri-list", url);
  dt.setData("text/plain", url);
  dt.setData("application/x-sfxsearch-file-id", hit.file_id);
  dt.setData("application/x-sfxsearch-filename", filename);
}

interface RowActions {
  select: (idx: number) => void;
  play: (hit: SearchHit, seekS?: number) => void;
  openDetail: () => void;
  edit: (idx: number) => void;
  reveal: (e: React.MouseEvent, hit: SearchHit) => void;
  similar: (fileId: string, filename?: string) => void;
  favorite: (e: React.MouseEvent, hit: SearchHit) => void;
  dragEnd: () => void;
}

interface ResultRowProps {
  hit: SearchHit;
  idx: number;
  isSelected: boolean;
  isRowPlaying: boolean;
  rowTime: number | null;
  rowRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
  actions: RowActions;
}

// Memoized so the ~30fps playhead updates only re-render the playing row.
const ResultRow = React.memo(function ResultRow({
  hit,
  idx,
  isSelected,
  isRowPlaying,
  rowTime,
  rowRefs,
  actions,
}: ResultRowProps) {
  return (
    <div
      ref={(el) => {
        rowRefs.current[idx] = el;
      }}
      role="listitem"
      aria-current={isSelected || undefined}
      draggable
      onClickCapture={(e) => {
        // Mouse clicks must not leave focus on a row button (it would swallow
        // Space/Enter); keyboard activations have detail === 0 and keep focus.
        if (e.detail > 0 && e.target instanceof Element) {
          (e.target.closest("button") as HTMLElement | null)?.blur();
        }
      }}
      onPointerDown={() => prefetchDragFile(hit)}
      onDragStart={(e) => handleRowDragStart(e, hit)}
      onDragEnd={() => actions.dragEnd()}
      onClick={(e) => {
        if (e.detail > 1) {
          return;
        }
        actions.select(idx);
        actions.play(hit);
      }}
      onDoubleClick={() => {
        actions.select(idx);
        actions.openDetail();
      }}
      style={
        {
          "--row-idx": Math.min(idx % PAGE_SIZE, 12),
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
          actions.select(idx);
          actions.play(hit);
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
          <span
            className="sfx-row-filename"
            title={hit.filename}
          >
            {hit.filename}
          </span>
          {hit.user_tags.map((t) => (
            <span key={t} className="ds-badge ds-badge-accent">
              {t}
            </span>
          ))}
        </div>
        <div className="sfx-row-folder" title={hit.folder}>
          {formatQuietFolder(hit.folder, hit.root)}
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
            actions.select(idx);
            actions.play(hit, timeS);
          }}
        />
      </div>

      <div className="sfx-row-specs">
        <span className="sfx-row-dur">
          {hit.duration_s.toFixed(2)}s
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
            color:
              hit.clap_score !== null && hit.clap_score > 0.25
                ? "var(--text-secondary)"
                : "var(--text-tertiary)",
          }}
        >
          {hit.clap_score !== null
            ? `${(hit.clap_score * 100).toFixed(0)}%`
            : hit.bm25_score !== null
            ? `${hit.bm25_score.toFixed(1)} kw`
            : "—"}
        </span>
      </div>

      <div className="sfx-row-actions">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            actions.edit(idx);
          }}
          className="sfx-icon-btn"
          aria-label="Edit audio"
          title="Edit audio (E)"
        >
          <Sliders size={14} />
        </button>

        <button
          type="button"
          onClick={(e) => actions.reveal(e, hit)}
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
            actions.similar(hit.file_id, hit.filename);
          }}
          className="sfx-icon-btn"
          aria-label="Find similar sounds"
          title="Find similar sounds"
        >
          <Sparkles size={14} />
        </button>

        <button
          type="button"
          onClick={(e) => actions.favorite(e, hit)}
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
});

export const App: React.FC = () => {
  const [query, setQuery] = useState<string>("");
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [sort, setSort] = useState<SortMode>("relevance");
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
  const [missingRoots, setMissingRoots] = useState<string[]>([]);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [indexing, setIndexing] = useState<IndexingProgress | null>(null);
  const [availFilters, setAvailFilters] = useState<AvailableFilters | null>(null);
  const [folderIndex, setFolderIndex] = useState<FolderEntry[]>([]);
  const [folderFilterText, setFolderFilterText] = useState<string>("");
  const [folderPaneOpen, setFolderPaneOpen] = useState<boolean>(true);
  const [folderPaneW, setFolderPaneW] = useState<number>(236);
  const [inspectorW, setInspectorW] = useState<number>(410);
  const paneDragRef = useRef<{
    side: "l" | "r";
    startX: number;
    startW: number;
  } | null>(null);
  const [libraryModalOpen, setLibraryModalOpen] = useState<boolean>(false);

  const [results, setResults] = useState<SearchHit[]>([]);
  const [totalResults, setTotalResults] = useState<number>(0);
  const [searchSeq, setSearchSeq] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [isSimilarityView, setIsSimilarityView] = useState<boolean>(false);
  const [statusLabel, setStatusLabel] = useState<string>("");

  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [appView, setAppView] = useState<"library" | "editor">("library");
  // Below the 960px breakpoint the inspector is a blocking overlay, so it
  // starts collapsed there -- the edge tab (or Enter) opens it explicitly.
  const [detailOpen, setDetailOpen] = useState<boolean>(
    () => window.innerWidth >= 960
  );

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
  const resultsListRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const prevOkFilesRef = useRef<number>(0);
  const searchReqRef = useRef<number>(0);
  const nextOffsetRef = useRef<number>(0);
  const favPendingRef = useRef<Set<string>>(new Set());
  const userSearchReqRef = useRef<number>(0);
  const paginationFailedRef = useRef<boolean>(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const committedSearchRef = useRef<{
    q: string;
    m: SearchMode;
    f: FilterState;
    s: SortMode;
  } | null>(null);
  const resultsRef = useRef<SearchHit[]>([]);
  const lastTimeRef = useRef<number>(-1);

  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

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
      filtersOverride?: FilterState,
      sortOverride?: SortMode,
      preserveView: boolean = false
    ) => {
      let q = qOverride !== undefined ? qOverride : query;
      let m = modeOverride !== undefined ? modeOverride : mode;
      let f = filtersOverride !== undefined ? filtersOverride : filters;
      let s = sortOverride !== undefined ? sortOverride : sort;
      if (preserveView) {
        // A user search in flight always wins over a poll refresh.
        if (userSearchReqRef.current !== 0) {
          return;
        }
        const committed = committedSearchRef.current;
        if (!committed) {
          return;
        }
        ({ q, m, f, s } = committed);
      }

      const effectiveMode: SearchMode = !q.trim() ? "keyword_only" : m;
      const reqId = ++searchReqRef.current;
      if (!preserveView) {
        userSearchReqRef.current = reqId;
        setLoading(true);
        setIsSimilarityView(false);
        setStatusLabel("");
      }
      try {
        const limit = preserveView
          ? Math.min(Math.max(PAGE_SIZE, resultsRef.current.length), 500)
          : PAGE_SIZE;
        const page = await searchSounds(q, effectiveMode, f, limit, 0, s);
        if (reqId !== searchReqRef.current) {
          return;
        }
        setResults(page.results);
        setTotalResults(page.total);
        nextOffsetRef.current = page.offset + page.count;
        if (preserveView) {
          setSelectedIndex((prev) =>
            Math.min(prev, Math.max(0, page.results.length - 1))
          );
        } else {
          committedSearchRef.current = { q, m, f, s };
          paginationFailedRef.current = false;
          setSearchSeq((seq) => seq + 1);
          setSelectedIndex(0);
          resultsListRef.current?.scrollTo({ top: 0 });
          if (q.trim()) {
            recordHistory(q);
          }
        }
      } catch (err) {
        // Keep the last good page on failure; committed params still match it.
        if (reqId === searchReqRef.current && !preserveView) {
          setStatusLabel(err instanceof Error ? err.message : "Search failed");
        }
      } finally {
        // A non-preserve request owns `loading` while it is the newest user
        // search, even if a similarity query superseded it in the meantime.
        if (!preserveView && userSearchReqRef.current === reqId) {
          userSearchReqRef.current = 0;
          setLoading(false);
        }
      }
    },
    [query, mode, filters, sort, recordHistory]
  );

  const loadMoreResults = useCallback(async () => {
    if (
      loading ||
      loadingMore ||
      isSimilarityView ||
      paginationFailedRef.current ||
      results.length === 0 ||
      results.length >= totalResults
    ) {
      return;
    }
    const committed = committedSearchRef.current;
    if (!committed) {
      return;
    }
    const effectiveMode: SearchMode = !committed.q.trim()
      ? "keyword_only"
      : committed.m;
    const reqId = searchReqRef.current;
    const offset = nextOffsetRef.current || results.length;
    setLoadingMore(true);
    try {
      const page = await searchSounds(
        committed.q,
        effectiveMode,
        committed.f,
        PAGE_SIZE,
        offset,
        committed.s
      );
      if (reqId !== searchReqRef.current) {
        return;
      }
      // count===0 despite total>offset means dedupe/removed files starved the
      // page; clamp to loaded rows so the sentinel stops re-firing.
      setTotalResults(
        page.count > 0 ? page.total : Math.min(page.total, results.length)
      );
      nextOffsetRef.current =
        page.count > 0 ? offset + page.count : Math.max(offset, page.total);
      if (page.results.length > 0) {
        setResults((prev) => {
          const seen = new Set(prev.map((h) => h.file_id));
          const appended = page.results.filter((h) => !seen.has(h.file_id));
          return [...prev, ...appended];
        });
      }
    } catch {
      // Suppress retries until the next fresh search — the sentinel would
      // otherwise re-fire every round trip on a persistent failure.
      paginationFailedRef.current = true;
    } finally {
      setLoadingMore(false);
    }
  }, [loading, loadingMore, isSimilarityView, results.length, totalResults]);

  // Transient messages auto-clear; the "Similar to …" label belongs to the view.
  useEffect(() => {
    if (!statusLabel || isSimilarityView || loading) {
      return;
    }
    const timer = window.setTimeout(() => setStatusLabel(""), 5000);
    return () => window.clearTimeout(timer);
  }, [statusLabel, isSimilarityView, loading]);

  useEffect(() => {
    rowRefs.current.length = results.length;
  }, [results.length]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const rootEl = resultsListRef.current;
    if (
      !sentinel ||
      !rootEl ||
      isSimilarityView ||
      results.length === 0 ||
      results.length >= totalResults ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadMoreResults();
            break;
          }
        }
      },
      { root: rootEl, rootMargin: "0px 0px 320px 0px" }
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [loadMoreResults, isSimilarityView, results.length, totalResults]);

  const refreshLibraryState = useCallback(async () => {
    try {
      const lib = await fetchLibraryState();
      setRoots(lib.roots);
      setMissingRoots(lib.missing_roots ?? []);
      setStats(lib.stats);
      setIndexing(lib.indexing);

      const prevOk = prevOkFilesRef.current;
      const nextOk = lib.stats.ok_files;
      prevOkFilesRef.current = nextOk;

      if (nextOk !== prevOk) {
        fetchAvailableFilters().then(setAvailFilters).catch(() => {});
        fetchFolders().then(setFolderIndex).catch(() => {});
        if (prevOk === 0 && nextOk > 0) {
          runSearch();
        } else if (
          lib.indexing?.state === "running" &&
          !isSimilarityView &&
          !loading
        ) {
          // Newly indexed files mid-run: refresh results without resetting
          // scroll/selection or writing the query to history.
          runSearch(undefined, undefined, undefined, undefined, true);
        }
      }
      if (nextOk === 0) {
        // Invalidate in-flight search/pagination so a late response can't
        // repopulate cleared results.
        searchReqRef.current += 1;
        setResults((prev) => (prev.length ? [] : prev));
        setTotalResults(0);
      }
    } catch {
      // ignore transient poll errors
    }
  }, [runSearch, isSimilarityView, loading]);

  useEffect(() => {
    refreshLibraryState();
    fetchAvailableFilters().then(setAvailFilters).catch(() => {});
    fetchFolders().then(setFolderIndex).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshRef.current = refreshLibraryState;
  });

  useEffect(() => {
    // Keyed only on indexing state so typing in the search box doesn't
    // keep re-arming the poll timer.
    if (indexing?.state !== "running") {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshRef.current();
    }, 1200);
    return () => window.clearInterval(timer);
  }, [indexing?.state]);

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

  // Playhead tracking while audio is actively playing; throttled to ~30fps so
  // the whole results list isn't reconciled every single frame.
  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    let rafId = 0;
    let last = 0;
    const tick = (ts: number) => {
      if (audioRef.current && !audioRef.current.paused && ts - last > 33) {
        last = ts;
        const t = audioRef.current.currentTime;
        if (Math.abs(t - lastTimeRef.current) > 0.001) {
          lastTimeRef.current = t;
          setCurrentTimeS(t);
        }
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [isPlaying]);

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

      if (playingFileId === hit.file_id) {
        if (explicitSeekS === undefined) {
          if (!audio.paused) {
            audio.pause();
            setIsPlaying(false);
          } else {
            audio.play().catch(() => {});
            setIsPlaying(true);
          }
          return;
        }
        // Scrub seek on the already-loaded file: move the playhead only,
        // never reassign src (would tear down and reload the stream).
        audio.currentTime = Math.max(0, startOffset);
        if (audio.paused) {
          audio
            .play()
            .then(() => setIsPlaying(true))
            .catch(() => setIsPlaying(false));
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

  const openEditorForHit = useCallback((idx?: number) => {
    if (idx !== undefined) {
      setSelectedIndex(idx);
    }
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
    setAppView("editor");
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (appView === "editor") {
        return;
      }
      if (libraryModalOpen) {
        if (e.key === "Escape") {
          setLibraryModalOpen(false);
        }
        return;
      }

      const targetEl = e.target as HTMLElement | null;
      const tag = targetEl?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        if (e.key === "Escape") {
          (e.target as HTMLElement).blur();
        }
        return;
      }
      // Space/Enter on a focused control must activate it natively, not the app.
      // (Row buttons blur after a mouse click, so lingering focus never lands here.)
      const onControl = !!targetEl?.closest?.(
        "button, a, [role='button'], [role='option'], [role='menuitem'], [role='switch'], [role='checkbox']"
      );
      if (onControl && (e.key === " " || e.key === "Enter")) {
        return;
      }

      if (e.key === "Escape") {
        // Not inside an input (handled above); an open dropdown owns Escape.
        if (!document.querySelector(".ds-select-pop")) {
          setDetailOpen(false);
        }
        return;
      }

      // An open DsSelect owns the arrow keys.
      if (
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        document.querySelector(".ds-select-pop")
      ) {
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (results.length === 0) {
          return;
        }
        const next = Math.min(results.length - 1, Math.max(0, selectedIndex + 1));
        setSelectedIndex(next);
        rowRefs.current[next]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (results.length === 0) {
          return;
        }
        const next = Math.max(0, selectedIndex - 1);
        setSelectedIndex(next);
        rowRefs.current[next]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === " ") {
        e.preventDefault();
        if (e.repeat) {
          return;
        }
        const currentHit = results[selectedIndex];
        if (currentHit) {
          playHit(currentHit);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (e.repeat) {
          return;
        }
        if (results[selectedIndex]) {
          setDetailOpen((prev) => !prev);
        }
      } else if (
        (e.key === "e" || e.key === "E") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.repeat
      ) {
        e.preventDefault();
        if (results[selectedIndex]) {
          openEditorForHit(selectedIndex);
        }
      } else if (
        (e.key === "r" || e.key === "R") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.repeat
      ) {
        e.preventDefault();
        const currentHit = results[selectedIndex];
        if (currentHit) {
          revealInExplorer(currentHit.file_id).catch(() =>
            setStatusLabel("Reveal failed")
          );
        }
      } else if (
        (e.key === "f" || e.key === "F") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.repeat
      ) {
        e.preventDefault();
        const currentHit = results[selectedIndex];
        if (currentHit) {
          void toggleFavoriteFile(currentHit);
        }
      } else if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [results, selectedIndex, playHit, libraryModalOpen, appView, openEditorForHit]);

  const handleAddRoot = async (path: string) => {
    const res = await addLibraryRoot(path);
    setRoots(res.roots);
    setIndexing(res.indexing);
    await refreshLibraryState();
  };

  const handleBrowseAndAddRoot = async () => {
    try {
      const picked = await pickNativeFolder();
      if (picked) {
        await handleAddRoot(picked);
      }
    } catch (err) {
      setOnboardingError(
        err instanceof Error ? err.message : "Could not add folder"
      );
      setStatusLabel(err instanceof Error ? err.message : "Add folder failed");
    }
  };

  const handleRemoveRoot = async (path: string) => {
    try {
      const res = await removeLibraryRoot(path, true);
      setRoots(res.roots);
      setStats(res.stats);
      setIndexing(res.indexing);
      prevOkFilesRef.current = res.stats.ok_files;
      if (res.stats.ok_files === 0) {
        searchReqRef.current += 1;
        setResults([]);
        setTotalResults(0);
        setIsSimilarityView(false);
      } else {
        // Re-run the committed search (not whatever is typed in the box).
        const committed = committedSearchRef.current;
        runSearch(committed?.q, committed?.m, committed?.f, committed?.s);
      }
    } catch (err) {
      setStatusLabel(err instanceof Error ? err.message : "Failed to remove folder");
    }
  };

  const handleRescan = async (reindex: boolean) => {
    try {
      const res = await rescanLibrary(reindex);
      setRoots(res.roots);
      setIndexing(res.indexing);
      void refreshLibraryState();
    } catch (err) {
      setStatusLabel(err instanceof Error ? err.message : "Rescan failed");
    }
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

  const handleFindSimilarFile = async (fileId: string, filename?: string) => {
    const reqId = ++searchReqRef.current;
    userSearchReqRef.current = reqId;
    setLoading(true);
    try {
      const hits = await findSimilarById(fileId, undefined, 40);
      if (reqId !== searchReqRef.current) {
        return;
      }
      setResults(hits);
      setTotalResults(hits.length);
      setIsSimilarityView(true);
      setSearchSeq((s) => s + 1);
      setSelectedIndex(0);
      resultsListRef.current?.scrollTo({ top: 0 });
      setStatusLabel(`Similar to ${filename ?? fileId.slice(0, 8)}`);
    } catch (err) {
      if (reqId === searchReqRef.current) {
        setStatusLabel(err instanceof Error ? err.message : "Similarity search failed");
      }
    } finally {
      if (userSearchReqRef.current === reqId) {
        userSearchReqRef.current = 0;
        setLoading(false);
      }
    }
  };

  const handleFindSimilarChunk = async (
    fileId: string,
    chunkIdx: number,
    filename?: string
  ) => {
    const reqId = ++searchReqRef.current;
    userSearchReqRef.current = reqId;
    setLoading(true);
    try {
      const hits = await findSimilarById(fileId, chunkIdx, 40);
      if (reqId !== searchReqRef.current) {
        return;
      }
      setResults(hits);
      setTotalResults(hits.length);
      setIsSimilarityView(true);
      setSearchSeq((s) => s + 1);
      setSelectedIndex(0);
      resultsListRef.current?.scrollTo({ top: 0 });
      setStatusLabel(
        `Similar to ${filename ?? fileId.slice(0, 8)} · chunk #${chunkIdx}`
      );
    } catch (err) {
      if (reqId === searchReqRef.current) {
        setStatusLabel(err instanceof Error ? err.message : "Similarity search failed");
      }
    } finally {
      if (userSearchReqRef.current === reqId) {
        userSearchReqRef.current = 0;
        setLoading(false);
      }
    }
  };

  const handleDropFile = async (file: File) => {
    const reqId = ++searchReqRef.current;
    userSearchReqRef.current = reqId;
    setLoading(true);
    setStatusLabel(`Embedding reference '${file.name}'`);
    try {
      const hits = await findSimilarByUpload(file, 40);
      if (reqId !== searchReqRef.current) {
        return;
      }
      setResults(hits);
      setTotalResults(hits.length);
      setIsSimilarityView(true);
      setSearchSeq((s) => s + 1);
      setSelectedIndex(0);
      resultsListRef.current?.scrollTo({ top: 0 });
      setStatusLabel(`Similar to '${file.name}'`);
    } catch (err) {
      if (reqId === searchReqRef.current) {
        setStatusLabel(err instanceof Error ? err.message : "Upload failed");
      }
    } finally {
      if (userSearchReqRef.current === reqId) {
        userSearchReqRef.current = 0;
        setLoading(false);
      }
    }
  };

  const handleRevealRow = async (e: React.MouseEvent, hit: SearchHit) => {
    e.stopPropagation();
    try {
      await revealInExplorer(hit.file_id);
    } catch {
      setStatusLabel(`Could not reveal '${hit.filename}'`);
    }
  };

  const toggleFolderFilter = useCallback(
    (path: string) => {
      const normPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
      const sel = new Set(filters.folders);
      if (sel.has(normPath)) {
        sel.delete(normPath);
      } else {
        sel.add(normPath);
        const lowerPrefix = normPath.toLowerCase() + "/";
        for (const p of [...sel]) {
          if (p !== normPath && p.toLowerCase().startsWith(lowerPrefix)) {
            sel.delete(p);
          }
        }
      }
      const next = { ...filters, folders: [...sel].sort() };
      setFilters(next);
      runSearch(query, mode, next, sort);
    },
    [filters, query, mode, sort, runSearch]
  );

  const clearFolderFilters = useCallback(() => {
    const next = { ...filters, folders: [] };
    setFilters(next);
    runSearch(query, mode, next, sort);
  }, [filters, query, mode, sort, runSearch]);

  const handlePaneDragDown =
    (side: "l" | "r") => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.classList.add("dragging");
      document.body.classList.add("sfx-resizing-x");
      paneDragRef.current = {
        side,
        startX: e.clientX,
        startW: side === "l" ? folderPaneW : inspectorW,
      };
    };

  const handlePaneDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = paneDragRef.current;
    if (!d) {
      return;
    }
    const dx = e.clientX - d.startX;
    if (d.side === "l") {
      setFolderPaneW(Math.min(480, Math.max(220, d.startW + dx)));
    } else {
      setInspectorW(Math.min(720, Math.max(300, d.startW - dx)));
    }
  };

  const handlePaneDragUp = (e: React.PointerEvent<HTMLDivElement>) => {
    paneDragRef.current = null;
    e.currentTarget.classList.remove("dragging");
    document.body.classList.remove("sfx-resizing-x");
  };

  const toggleFavoriteFile = async (hit: SearchHit) => {
    if (favPendingRef.current.has(hit.file_id)) {
      return;
    }
    favPendingRef.current.add(hit.file_id);
    try {
      const updated = await updateUserData(hit.file_id, {
        favorite: !hit.favorite,
      });
      handleUserUpdated(
        hit.file_id,
        updated.favorite,
        updated.user_tags,
        updated.note
      );
    } catch (err) {
      setStatusLabel(err instanceof Error ? err.message : "Favorite update failed");
    } finally {
      favPendingRef.current.delete(hit.file_id);
    }
  };

  const handleToggleFavoriteRow = async (
    e: React.MouseEvent,
    hit: SearchHit
  ) => {
    e.stopPropagation();
    await toggleFavoriteFile(hit);
  };

  // Stable action bundle for memoized rows; always delegates to the latest
  // handlers so rows don't re-render when those closures change.
  const rowHandlersRef = useRef<RowActions | null>(null);
  rowHandlersRef.current = {
    select: setSelectedIndex,
    play: playHit,
    openDetail: () => setDetailOpen(true),
    edit: openEditorForHit,
    reveal: handleRevealRow,
    similar: handleFindSimilarFile,
    favorite: handleToggleFavoriteRow,
    dragEnd: () => setIsDraggingFile(false),
  };
  const rowActions = useMemo<RowActions>(
    () => ({
      select: (i) => rowHandlersRef.current?.select(i),
      play: (h, t) => rowHandlersRef.current?.play(h, t),
      openDetail: () => rowHandlersRef.current?.openDetail(),
      edit: (i) => rowHandlersRef.current?.edit(i),
      reveal: (e, h) => rowHandlersRef.current?.reveal(e, h),
      similar: (id, n) => rowHandlersRef.current?.similar(id, n),
      favorite: (e, h) => rowHandlersRef.current?.favorite(e, h),
      dragEnd: () => rowHandlersRef.current?.dragEnd(),
    }),
    []
  );

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

  const handleSavedToLibrary = useCallback(
    (newHit: SearchHit) => {
      setResults((prev) => {
        const existingIdx = prev.findIndex((h) => h.file_id === newHit.file_id);
        if (existingIdx >= 0) {
          const next = [...prev];
          next[existingIdx] = newHit;
          return next;
        }
        return [newHit, ...prev];
      });
      setTotalResults((prev) => prev + 1);
      setSelectedIndex(0);
      void refreshLibraryState();
    },
    []
  );

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
  const activeFilterCount = [
    filters.minDuration,
    filters.maxDuration,
    filters.minLufs,
    filters.maxLufs,
    filters.format,
    filters.root,
    filters.minLoopScore,
    filters.userTag,
    filters.favoritesOnly ? "fav" : "",
    filters.folders.length ? "folders" : "",
  ].filter(Boolean).length;

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
        if (!hasIndexedFiles) {
          return;
        }
        const selfFileId = e.dataTransfer.getData(
          "application/x-sfxsearch-file-id"
        );
        if (selfFileId) {
          void handleFindSimilarFile(
            selfFileId,
            resultsRef.current.find((h) => h.file_id === selfFileId)?.filename
          );
          return;
        }
        const f = e.dataTransfer.files?.[0];
        if (f) {
          handleDropFile(f);
          return;
        }
        const uri =
          e.dataTransfer.getData("text/uri-list") ||
          e.dataTransfer.getData("text/plain");
        try {
          const u = new URL(uri);
          if (
            u.origin === window.location.origin &&
            u.pathname.startsWith("/api/audio/")
          ) {
            void fetch(u)
              .then((res) => (res.ok ? res.blob() : Promise.reject(res)))
              .then((blob) =>
                handleDropFile(
                  new File([blob], "dropped-audio", {
                    type: blob.type || "application/octet-stream",
                  })
                )
              )
              .catch(() => setStatusLabel("Dropped audio URL failed to load"));
          }
        } catch {
          // not a URL payload — nothing to do
        }
      }}
    >
      {/* Shared HTML5 audio element */}
      <audio
        ref={audioRef}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          lastTimeRef.current = t;
          setCurrentTimeS(t);
        }}
        onEnded={() => setIsPlaying(false)}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onError={() => {
          setIsPlaying(false);
          setPlayingFileId(null);
          setStatusLabel("Audio playback failed");
        }}
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

      {appView === "editor" ? (
        <StudioView
          hit={selectedHit}
          hasPrev={selectedIndex > 0}
          hasNext={selectedIndex < results.length - 1}
          onPrevHit={() =>
            setSelectedIndex((prev) => Math.max(0, prev - 1))
          }
          onNextHit={() =>
            setSelectedIndex((prev) =>
              Math.min(results.length - 1, prev + 1)
            )
          }
          onBackToLibrary={() => setAppView("library")}
          onFindSimilarFromAudio={(file) => {
            setAppView("library");
            void handleDropFile(file);
          }}
          onSavedToLibrary={handleSavedToLibrary}
        />
      ) : (
        <>
          {/* Top Two-Tier Studio Header: Row 1 = Transport & Utilities, Row 2 = Hero Search Command Bar */}
          <header className="sfx-toolbar">
            {/* Tier 1: Brand + Digital Transport Readout + Workspace Controls */}
            <div className="sfx-topbar">
              <div className="sfx-brand">
                <div className="sfx-brand-mark">
                  <Volume2 size={15} />
                </div>
                <span className="sfx-brand-title">sfx-search</span>
                <span className="sfx-brand-count ds-tnum">
                  {stats ? `${stats.ok_files.toLocaleString()} sounds` : ""}
                </span>
              </div>

              <div className="sfx-transport-strip" aria-label="Playback transport">
                <span className="sfx-readout-val warm">
                  {(() => {
                    const activeHit =
                      (isPlaying && playingHit) || selectedHit || playingHit;
                    if (!activeHit) {
                      return "00.00s / 00.00s";
                    }
                    const pos =
                      playingFileId === activeHit.file_id
                        ? currentTimeS
                        : activeHit.best_offset_s;
                    return `${pos.toFixed(2).padStart(5, "0")}s / ${activeHit.duration_s
                      .toFixed(2)
                      .padStart(5, "0")}s`;
                  })()}
                </span>

                <SpectrumMeter
                  audioElement={audioRef.current}
                  isPlaying={isPlaying}
                />

                <div className="sfx-divider-v" />

                <button
                  type="button"
                  role="switch"
                  aria-checked={startAtBestOffset}
                  className="ds-switch-item"
                  style={{
                    background: "none",
                    border: 0,
                    padding: 0,
                    font: "inherit",
                  }}
                  onClick={() => setStartAtBestOffset((prev) => !prev)}
                  title="Start playback at best-matching 10s window offset"
                >
                  <div className={`ds-switch-track ${startAtBestOffset ? "on" : ""}`}>
                    <div className="ds-switch-thumb" />
                  </div>
                  <span
                    className="ds-switch-label"
                    style={{
                      fontSize: "var(--font-size-xs)",
                      color: "var(--text-secondary)",
                    }}
                  >
                    Best offset
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setLoopEnabled((prev) => !prev)}
                  className={`ds-btn ds-btn-sm ${
                    loopEnabled ? "ds-btn-primary" : "ds-btn-ghost"
                  }`}
                  aria-pressed={loopEnabled}
                  title="Loop playback"
                >
                  <Repeat size={13} />
                  Loop
                </button>
              </div>

              <div className="sfx-workspace-tools">
                <button
                  type="button"
                  onClick={() => openEditorForHit(selectedIndex)}
                  className="ds-btn ds-btn-primary ds-btn-sm"
                  title="Open Audio Editor (E)"
                >
                  <Sliders size={14} />
                  Edit Audio
                </button>

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
                  className="sfx-icon-btn"
                  style={{
                    color: compactDensity ? "var(--primary-400)" : undefined,
                  }}
                  aria-pressed={compactDensity}
                  aria-label={
                    compactDensity
                      ? "Switch to spacious density"
                      : "Switch to compact density"
                  }
                  title={
                    compactDensity
                      ? "Switch to spacious density"
                      : "Switch to compact density"
                  }
                >
                  <Rows3 size={15} />
                </button>

              </div>
            </div>

        {/* Tier 2: Full-Width Hero Search Command Bar */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setShowHistory(false);
            if (hasIndexedFiles) {
              runSearch();
            }
          }}
          className="sfx-command-row"
        >
          <div className="sfx-search-box-wrap">
            <div
              className={`sfx-search-hero-box ${
                !hasIndexedFiles ? "disabled" : ""
              }`}
            >
              <Search size={17} className="sfx-search-hero-icon" />
              <input
                ref={searchInputRef}
                type="text"
                aria-label="Search sounds"
                disabled={!hasIndexedFiles}
                value={query}
                onFocus={() => setShowHistory(true)}
                onBlur={() => setTimeout(() => setShowHistory(false), 180)}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  hasIndexedFiles
                    ? 'Search sounds by description ("heavy wooden door slam, reverb") or operators (dur:0-2 loop:true -voice)...'
                    : "Search unlocks once your first sound file is indexed"
                }
                className="sfx-search-hero-input"
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
              {!query && hasIndexedFiles && (
                <kbd
                  className="sfx-kbd"
                  title="Press / anywhere to focus search"
                  style={{ flexShrink: 0 }}
                >
                  /
                </kbd>
              )}
              {history.length > 0 && hasIndexedFiles && (
                <button
                  type="button"
                  onClick={() => setShowHistory((prev) => !prev)}
                  className="sfx-icon-btn"
                  aria-label="Recent queries and syntax helpers"
                  title="Recent queries & syntax helpers"
                >
                  <History size={14} />
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
                  top: "calc(100% + 6px)",
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

          <div className="sfx-command-actions">
            <DsSelect
              disabled={!hasIndexedFiles}
              value={mode}
              width={148}
              height="var(--control-height-lg)"
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
                  runSearch(query, nextMode, filters, sort);
                }
              }}
            />

            <DsSelect
              disabled={!hasIndexedFiles}
              value={sort}
              width={154}
              height="var(--control-height-lg)"
              ariaLabel="Sort order"
              options={[
                { value: "relevance", label: "Sort: Relevance" },
                { value: "name_asc", label: "Name (A–Z)" },
                { value: "name_desc", label: "Name (Z–A)" },
                { value: "duration_asc", label: "Shortest first" },
                { value: "duration_desc", label: "Longest first" },
                { value: "lufs_desc", label: "Loudest first" },
                { value: "lufs_asc", label: "Quietest first" },
              ]}
              onChange={(val) => {
                const nextSort = val as SortMode;
                setSort(nextSort);
                if (hasIndexedFiles) {
                  runSearch(query, mode, filters, nextSort);
                }
              }}
            />

            <button
              type="submit"
              disabled={!hasIndexedFiles || loading}
              className="ds-btn ds-btn-primary sfx-btn-lg"
            >
              <Search size={15} />
              {loading ? "Searching" : "Search"}
            </button>

            <button
              type="button"
              disabled={!hasIndexedFiles}
              onClick={() => setShowFilters((prev) => !prev)}
              className={`ds-btn sfx-btn-lg ${
                showFilters || activeFilterCount > 0
                  ? "ds-btn-secondary"
                  : "ds-btn-ghost"
              }`}
            >
              <Filter size={14} />
              Filters
              {activeFilterCount > 0 && (
                <span className="ds-badge ds-badge-accent ds-tnum">
                  {activeFilterCount}
                </span>
              )}
            </button>

            <label
              className={`ds-btn ds-btn-secondary sfx-btn-lg ${
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
                  e.target.value = "";
                  if (f) {
                    handleDropFile(f);
                  }
                }}
              />
            </label>
          </div>
        </form>

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
              <button
                type="button"
                role="checkbox"
                aria-checked={filters.favoritesOnly}
                className="ds-check"
                style={{
                  height: "var(--control-height-md)",
                  background: "none",
                  border: 0,
                  padding: 0,
                  font: "inherit",
                }}
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
              </button>

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
                  {!hasIndexedFiles &&
                    " — search unlocks as soon as the first file finishes"}
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

      {/* Missing Library Roots Warning */}
      {missingRoots.length > 0 && (
        <div className="sfx-warning-banner">
          <AlertTriangle size={14} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>
            {missingRoots.length === 1
              ? "Library folder not found on disk: "
              : "Library folders not found on disk: "}
            {missingRoots.join(" · ")}. Files may have moved — indexed results
            can be stale.
          </span>
          <button
            type="button"
            onClick={() => void handleRescan(false)}
            className="ds-btn ds-btn-ghost ds-btn-sm"
          >
            Rescan
          </button>
          <button
            type="button"
            onClick={() => setLibraryModalOpen(true)}
            className="ds-btn ds-btn-ghost ds-btn-sm"
          >
            Manage folders
          </button>
        </div>
      )}

      {/* Main Workspace */}
      <div
        className="sfx-workspace"
        style={{ "--sfx-inspector-w": `${inspectorW}px` } as React.CSSProperties}
      >
        {hasIndexedFiles && folderPaneOpen && (
          <aside className="sfx-folder-pane" style={{ width: folderPaneW }}>
            <div className="sfx-folder-head">
              <span className="ds-panel-title">Folders</span>
              <div className="sfx-folder-head-actions">
                {filters.folders.length > 0 && (
                  <button
                    type="button"
                    className="ds-btn ds-btn-ghost ds-btn-sm"
                    onClick={clearFolderFilters}
                    title="Clear folder selection"
                  >
                    Clear ({filters.folders.length})
                  </button>
                )}
                <button
                  type="button"
                  className="sfx-panel-btn"
                  onClick={() => setFolderPaneOpen(false)}
                  aria-label="Collapse folder panel"
                  title="Collapse folder panel"
                >
                  <PanelLeftClose size={16} />
                </button>
              </div>
            </div>
            <div className="sfx-folder-search ds-input-box">
              <input
                type="text"
                className="ds-input"
                value={folderFilterText}
                onChange={(e) => setFolderFilterText(e.target.value)}
                aria-label="Filter folders"
                placeholder="Filter folders..."
                spellCheck={false}
              />
            </div>
            <div className="sfx-ft-scroll ds-scroll">
              <FolderTree
                folders={folderIndex}
                roots={roots}
                selected={filters.folders}
                filterText={folderFilterText}
                onToggle={toggleFolderFilter}
              />
            </div>
          </aside>
        )}
        {hasIndexedFiles && folderPaneOpen && (
          <div
            className="sfx-pane-divider"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={handlePaneDragDown("l")}
            onPointerMove={handlePaneDragMove}
            onPointerUp={handlePaneDragUp}
            onPointerCancel={handlePaneDragUp}
          />
        )}
        {hasIndexedFiles && !folderPaneOpen && (
          <button
            type="button"
            className="sfx-pane-tab"
            onClick={() => setFolderPaneOpen(true)}
            aria-label="Expand folder panel"
            title="Expand folder panel"
          >
            <PanelLeftOpen size={16} />
            <span className="sfx-pane-tab-label">Folders</span>
          </button>
        )}
        <main className="sfx-main">
          {/* Sticky Column Header when files exist */}
          {hasIndexedFiles && (
            <div className="sfx-list-head">
              <span />
              <span>Sound</span>
              <span className="col-wave">Waveform</span>
              <span className="col-specs" style={{ textAlign: "right" }}>
                Duration
              </span>
              <span className="col-match" style={{ textAlign: "right" }}>
                Match
              </span>
              <span />
            </div>
          )}

          {/* Content: Onboarding Empty State vs Results List */}
          <div
            ref={resultsListRef}
            className="sfx-results-list ds-scroll"
            role={results.length > 0 ? "list" : undefined}
            aria-label={results.length > 0 ? "Search results" : undefined}
          >
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
              <>
                {results.map((hit, idx) => (
                  <ResultRow
                    key={`${hit.file_id}-${searchSeq}`}
                    hit={hit}
                    idx={idx}
                    isSelected={idx === selectedIndex}
                    isRowPlaying={playingFileId === hit.file_id && isPlaying}
                    rowTime={playingFileId === hit.file_id ? currentTimeS : null}
                    rowRefs={rowRefs}
                    actions={rowActions}
                  />
                ))}

                {!isSimilarityView && results.length < totalResults && (
                  <div
                    ref={loadMoreSentinelRef}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "var(--space-2)",
                      padding: "var(--space-4)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--font-size-xs)",
                      color: "var(--text-tertiary)",
                    }}
                  >
                    {paginationFailedRef.current ? (
                      <span>
                        Showing {results.length.toLocaleString()} of{" "}
                        {totalResults.toLocaleString()} (load failed — run the
                        search again to resume)
                      </span>
                    ) : (
                      <>
                        <span
                          className="ds-spinner"
                          style={{ width: 14, height: 14 }}
                        />
                        <span>
                          Loading more sounds ({results.length.toLocaleString()}{" "}
                          / {totalResults.toLocaleString()})...
                        </span>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Bottom Footer Status Bar */}
          <footer className="sfx-statusbar">
            <span className="ds-tnum">
              {statusLabel ||
                (hasIndexedFiles
                  ? `Showing ${results.length.toLocaleString()} of ${(
                      totalResults || results.length
                    ).toLocaleString()} sounds`
                  : roots.length === 0
                  ? "No library folders configured"
                  : "Indexing initial audio files...")}
              {isSimilarityView && (
                <button
                  type="button"
                  className="sfx-similar-exit"
                  title="Exit similarity view — back to search results"
                  aria-label="Exit similarity view"
                  onClick={() => {
                    setIsSimilarityView(false);
                    setStatusLabel("");
                    void runSearch();
                  }}
                >
                  <X size={11} />
                  exit
                </button>
              )}
            </span>
            <span className="sfx-statusbar-shortcuts">
              ↑↓ navigate · Space play · E edit · R reveal · F favorite · Enter inspector · / search · drag row to export
            </span>
          </footer>
        </main>

        {detailOpen && selectedHit && (
          <div
            className="sfx-pane-divider"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={handlePaneDragDown("r")}
            onPointerMove={handlePaneDragMove}
            onPointerUp={handlePaneDragUp}
            onPointerCancel={handlePaneDragUp}
          />
        )}
        {hasIndexedFiles && selectedHit && !detailOpen && (
          <button
            type="button"
            className="sfx-pane-tab sfx-pane-tab-right"
            onClick={() => setDetailOpen(true)}
            aria-label="Expand inspector"
            title="Expand inspector"
          >
            <PanelRightOpen size={16} />
            <span className="sfx-pane-tab-label">Inspector</span>
          </button>
        )}

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
              isPlaying={playingFileId === selectedHit.file_id && isPlaying}
              currentTimeS={
                playingFileId === selectedHit.file_id ? currentTimeS : null
              }
              onTogglePlay={() => playHit(selectedHit)}
              onSeek={(timeS) => playHit(selectedHit, timeS)}
              onClose={() => setDetailOpen(false)}
              onOpenEditor={() => openEditorForHit(selectedIndex)}
              onFindSimilarFile={handleFindSimilarFile}
              onFindSimilarChunk={handleFindSimilarChunk}
              onToggleFavorite={() => void toggleFavoriteFile(selectedHit)}
              onUserUpdated={handleUserUpdated}
            />
          </>
        )}
      </div>
      </>
      )}
    </div>
  );
};
