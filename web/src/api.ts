import {
  AvailableFilters,
  FileDetail,
  FilterState,
  FolderEntry,
  IndexingProgress,
  LibraryStateResponse,
  LibraryStats,
  SearchHit,
  SearchMode,
  SearchPageResponse,
  SortMode,
} from "./types";

export async function searchSounds(
  query: string,
  mode: SearchMode,
  filters: FilterState,
  k: number = 50,
  offset: number = 0,
  sort: SortMode = "relevance"
): Promise<SearchPageResponse> {
  const body = {
    query,
    k,
    offset,
    mode,
    sort,
    min_duration: filters.minDuration ? parseFloat(filters.minDuration) : null,
    max_duration: filters.maxDuration ? parseFloat(filters.maxDuration) : null,
    min_lufs: filters.minLufs ? parseFloat(filters.minLufs) : null,
    max_lufs: filters.maxLufs ? parseFloat(filters.maxLufs) : null,
    formats: filters.format ? [filters.format] : null,
    roots: filters.root ? [filters.root] : null,
    folders: filters.folders.length ? filters.folders : null,
    favorites_only: filters.favoritesOnly,
    user_tag: filters.userTag || null,
    min_loop_score: filters.minLoopScore ? parseFloat(filters.minLoopScore) : null,
  };

  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Search failed: ${res.statusText}`);
  }
  const data = await res.json();
  const results = (data.results as SearchHit[]) || [];
  return {
    results,
    count: typeof data.count === "number" ? data.count : results.length,
    total: typeof data.total === "number" ? data.total : results.length,
    offset: typeof data.offset === "number" ? data.offset : offset,
  };
}

export async function findSimilarById(
  fileId: string,
  chunkIdx?: number,
  k: number = 30
): Promise<SearchHit[]> {
  const params = new URLSearchParams({ k: String(k) });
  if (chunkIdx !== undefined) {
    params.set("chunk", String(chunkIdx));
  }
  const res = await fetch(`/api/similar/${encodeURIComponent(fileId)}?${params}`);
  if (!res.ok) {
    throw new Error(`Find similar failed: ${res.statusText}`);
  }
  const data = await res.json();
  return data.results as SearchHit[];
}

export async function findSimilarByUpload(
  file: File,
  k: number = 30
): Promise<SearchHit[]> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/similar/upload?k=${k}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Upload similar failed: ${res.statusText}`);
  }
  const data = await res.json();
  return data.results as SearchHit[];
}

export async function fetchFileDetail(fileId: string): Promise<FileDetail> {
  const res = await fetch(`/api/files/${encodeURIComponent(fileId)}`);
  if (!res.ok) {
    throw new Error(`Fetch file failed: ${res.statusText}`);
  }
  return (await res.json()) as FileDetail;
}

export async function fetchPeaks(fileId: string): Promise<number[]> {
  const res = await fetch(`/api/peaks/${encodeURIComponent(fileId)}`);
  if (!res.ok) {
    return [];
  }
  const data = await res.json();
  return (data.peaks as number[]) || [];
}

export async function updateUserData(
  fileId: string,
  payload: { favorite?: boolean; user_tags?: string[]; note?: string }
): Promise<{ file_id: string; favorite: boolean; user_tags: string[]; note: string }> {
  const res = await fetch(`/api/files/${encodeURIComponent(fileId)}/user`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Update user data failed: ${res.statusText}`);
  }
  return await res.json();
}

export async function revealInExplorer(fileId: string): Promise<void> {
  const res = await fetch(`/api/files/${encodeURIComponent(fileId)}/reveal`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Reveal failed: ${res.statusText}`);
  }
}

export async function fetchStats(): Promise<LibraryStats> {
  const res = await fetch("/api/stats");
  if (!res.ok) {
    throw new Error("Failed to fetch stats");
  }
  return (await res.json()) as LibraryStats;
}

export async function fetchFolders(): Promise<FolderEntry[]> {
  const res = await fetch("/api/folders");
  if (!res.ok) {
    throw new Error("Failed to fetch folders");
  }
  const data = await res.json();
  return (data.folders as FolderEntry[]) || [];
}

export async function fetchAvailableFilters(): Promise<AvailableFilters> {
  const res = await fetch("/api/filters");
  if (!res.ok) {
    throw new Error("Failed to fetch filters");
  }
  return (await res.json()) as AvailableFilters;
}

export async function fetchLibraryState(): Promise<LibraryStateResponse> {
  const res = await fetch("/api/library");
  if (!res.ok) {
    throw new Error("Failed to fetch library state");
  }
  return (await res.json()) as LibraryStateResponse;
}

export async function addLibraryRoot(
  path: string
): Promise<{ roots: string[]; indexing: IndexingProgress }> {
  const res = await fetch("/api/library/roots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Failed to add folder");
  }
  return await res.json();
}

export async function removeLibraryRoot(
  path: string,
  removeIndexedFiles: boolean = true
): Promise<LibraryStateResponse> {
  const res = await fetch("/api/library/roots", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, remove_indexed_files: removeIndexedFiles }),
  });
  if (!res.ok) {
    throw new Error("Failed to remove folder");
  }
  return await res.json();
}

export async function rescanLibrary(
  reindex: boolean = false
): Promise<{ roots: string[]; indexing: IndexingProgress }> {
  const res = await fetch("/api/library/rescan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reindex }),
  });
  if (!res.ok) {
    throw new Error("Failed to trigger rescan");
  }
  return await res.json();
}

export async function pickNativeFolder(): Promise<string | null> {
  const res = await fetch("/api/library/pick-folder", {
    method: "POST",
  });
  if (!res.ok) {
    return null;
  }
  const data = await res.json();
  return (data.path as string) || null;
}

/** Save Studio output into a library folder and index it; returns the new hit. */
export async function saveToLibraryFolder(
  wavBuffer: ArrayBuffer,
  options: {
    folder: string;
    /** Filename stem; a known audio extension is stripped by the backend. */
    name: string;
    overwrite: boolean;
    /** Library file whose favorite, tags and note the new file inherits. */
    sourceFileId: string | null;
    /** Tag the saved file "loop". */
    loop: boolean;
    /** Output format query params (format, bit_depth / bitrate); default 24-bit WAV. */
    encode: Record<string, string>;
  }
): Promise<SearchHit> {
  const params = new URLSearchParams(options.encode);
  params.set("folder", options.folder);
  params.set("name", options.name);
  params.set("overwrite", String(options.overwrite));
  params.set("loop", String(options.loop));
  if (options.sourceFileId) {
    params.set("source_file_id", options.sourceFileId);
  }

  const form = new FormData();
  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  form.append("file", blob, `${options.name}.wav`);

  const res = await fetch(`/api/library/save?${params}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Save failed: ${res.statusText}`);
  }
  const data = await res.json();
  return data.hit as SearchHit;
}
