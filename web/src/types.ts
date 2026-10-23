export type SearchMode = "hybrid" | "audio_only" | "keyword_only";

export type SortMode =
  | "relevance"
  | "name_asc"
  | "name_desc"
  | "duration_asc"
  | "duration_desc"
  | "lufs_desc"
  | "lufs_asc";

export interface SearchPageResponse {
  results: SearchHit[];
  count: number;
  total: number;
  offset: number;
}

export interface SearchHit {
  file_id: string;
  path: string;
  root: string;
  filename: string;
  folder: string;
  format: string;
  duration_s: number;
  sample_rate: number;
  channels: number;
  lufs_integrated: number | null;
  peak_dbfs: number;
  loop_score: number | null;
  tags: Record<string, string>;
  search_text: string;
  best_offset_s: number;
  best_end_s: number;
  best_chunk_idx: number;
  clap_score: number | null;
  bm25_score: number | null;
  rrf_score: number;
  favorite: boolean;
  user_tags: string[];
  note: string;
}

export interface ChunkInfo {
  chunk_idx: number;
  start_s: number;
  end_s: number;
}

export interface FileDetail extends SearchHit {
  size_bytes: number;
  mtime_ns: number;
  embedding_model: string;
  status: string;
  error: string | null;
  chunks: ChunkInfo[];
}

export interface FilterState {
  minDuration: string;
  maxDuration: string;
  minLufs: string;
  maxLufs: string;
  format: string;
  root: string;
  favoritesOnly: boolean;
  userTag: string;
  minLoopScore: string;
  folders: string[];
}

export interface FolderEntry {
  path: string;
  count: number;
}

export interface AvailableFilters {
  formats: string[];
  roots: string[];
  sample_rates: number[];
  channels: number[];
  min_duration_s: number;
  max_duration_s: number;
  min_lufs: number;
  max_lufs: number;
  user_tags: string[];
}

export interface IndexingProgress {
  state: "idle" | "running" | "error";
  error: string | null;
  scanned_count: number;
  skipped_unchanged: number;
  to_index_count: number;
  indexed_ok: number;
  indexed_errors: number;
  marked_missing: number;
  total_chunks: number;
  elapsed_seconds: number;
  files_per_min: number;
  audio_hours_per_hour: number;
  gpu_memory_mb: number;
  eta_seconds: number;
}

export interface LibraryStats {
  total_files: number;
  ok_files: number;
  error_files: number;
  missing_files: number;
  total_chunks: number;
  total_duration_s: number;
  total_duration_hours: number;
  total_size_bytes: number;
  embedding_model: string | null;
  embedding_dim: number | null;
  roots: string[];
  formats: Record<string, number>;
  favorites_count: number;
  configured_roots?: string[];
  indexing?: IndexingProgress;
}

export interface LibraryStateResponse {
  roots: string[];
  missing_roots: string[];
  stats: LibraryStats;
  indexing: IndexingProgress;
}

export const DEFAULT_FILTERS: FilterState = {
  minDuration: "",
  maxDuration: "",
  minLufs: "",
  maxLufs: "",
  format: "",
  root: "",
  favoritesOnly: false,
  userTag: "",
  minLoopScore: "",
  folders: [],
};
