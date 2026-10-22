# ADR 0002: Embedded LanceDB store with three-table schema and hybrid RRF search

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

`sfx-search` must index 30-100 GB of local audio files (tens of thousands of files and hundreds of thousands of 10-second chunks) on a single Windows workstation without requiring an external database server. Queries need to match both semantic audio content ("slow wooden floor creak") and exact metadata tokens ("BWF category, pack name, filename"), apply hard scalar filters (duration, LUFS, channels, sample rate, format, folder), locate the best-matching timestamp inside long recordings, and preserve user favorites/tags across full re-indexing runs.

## Decision

1. Use **LanceDB** as an embedded, on-disk columnar vector and full-text store in `./data`.
2. Split storage into three tables:
   - `files`: one row per audio file (`file_id`, manifest keys `size_bytes` and `mtime_ns`, acoustic features, normalized `search_text` with full-text index, mean-pooled `file_vec`, and `embedding_model`).
   - `chunks`: one row per audio window (`file_id`, `chunk_idx`, `start_s`, `end_s`, `vec`) for sub-file vector search and timestamp localization.
   - `user_data`: (`file_id`, `favorite`, `user_tags`, `note`), decoupled from `files` so re-indexing or switching embedding models never overwrites user curation.
3. Enforce model homogeneity per database: store `embedding_model` on records and `embedding_dim` in table metadata, and refuse to index or search if the configured checkpoint disagrees with the stored one.
4. Combine semantic and lexical retrieval via **Reciprocal Rank Fusion (RRF, `k = 60`)**:
   - Vector leg queries `chunks` (default top 300), groups by `file_id` taking the maximum chunk similarity, and records that chunk's `start_s` as `best_offset_s`.
   - Keyword leg runs BM25 full-text search over `files.search_text` (default top 100).
   - Scalar filters are pushed down into both legs before fusion.

## Consequences

- Zero-daemon deployment: both the FastAPI server and the standalone MCP server read the same `./data` directory directly.
- Grouping chunk KNN hits by `file_id` prevents long ambience or multi-take files with many chunks from dominating the top-k results while still pinpointing the exact `start_s` offset for UI auditioning.
- RRF (`k = 60`) merges incompatible score distributions (cosine similarity vs. unbounded BM25 scores) without fragile score calibration.
- Scalar filter pushdown into `chunks` requires either joining/filtering by eligible `file_id` sets or denormalizing filterable columns if LanceDB pre-filtering across tables becomes a bottleneck; this is tracked in the build spec verification items.
