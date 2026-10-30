# Architecture Overview

## What this is

`sfx-search` indexes local sound-effects libraries (30-100 GB of mixed audio formats and inconsistent metadata) so they can be searched offline by natural-language description, metadata keywords, acoustic filters, or reference audio similarity. It exposes search through a CLI, a FastAPI HTTP backend + React web UI, and an MCP server.

## Shape

```
+-------------------+      +-----------------------+      +------------------------+
|  Audio Library    | ---> |  Ingestion Pipeline   | ---> |  LanceDB (`./data`)    |
|  (WAV, FLAC, etc) |      |  - scan (manifest)    |      |  - files (meta + vec)  |
+-------------------+      |  - decode (ffmpeg)    |      |  - chunks (window vec) |
                           |  - metadata (BWF/tags)|      |  - user_data (fav/tag) |
                           |  - features (LUFS)    |      +------------------------+
                           |  - embed (CLAP GPU)   |                  |
                           +-----------------------+                  v
                                                          +------------------------+
                                                          |  Hybrid Search Engine  |
                                                          |  - KNN over chunks     |
                                                          |  - BM25 over files     |
                                                          |  - RRF (k=60) + filter |
                                                          +------------------------+
                                                             /        |         \
                                                            v         v          v
                                                       +-------+  +-------+  +-------+
                                                       |  CLI  |  |FastAPI|  |  MCP  |
                                                       +-------+  +-------+  +-------+
                                                                      |
                                                                      v
                                                                 +---------+
                                                                 | Web UI  |
                                                                 +---------+
```

## Key components

- **Scanner (`backend/scan.py`):** Walks configured library roots for supported extensions, diffs `(normalized_path, size_bytes, mtime_ns)` against the LanceDB `files` table, skips unchanged files, and marks deleted files as `status = missing`.
- **Decoder (`backend/decode.py`):** Runs a CPU worker pool (`cpu_count - 2`) spawning `ffprobe` for container metadata and `ffmpeg` subprocesses streaming 48 kHz, mono, `float32` PCM into a bounded queue feeding the GPU stage.
- **Metadata & Features (`backend/metadata.py`, `backend/features.py`):** Extracts container tags via `ffprobe`, parses WAV BWF `bext` and iXML chunks, tokenizes filenames and folder names into `search_text`, and computes integrated LUFS, sample/true peak dBFS, and an experimental boundary `loop_score`.
- **Embedder (`backend/embed.py`):** Slices decoded audio into 10 s windows with a 5 s hop (capped at 120 chunks per file by dynamically widening the hop on long files; repeat-padded for files under 10 s). Runs `laion/larger_clap_general` on GPU under `torch.inference_mode()` (`fp16` by default) to produce L2-normalized 512-d chunk vectors and a mean-pooled `file_vec`.
- **Store (`backend/store.py`):** Manages three LanceDB tables:
  - `files`: file manifest, acoustic features, `search_text` (FTS-indexed), `file_vec`, `embedding_model`, and `status`.
  - `chunks`: `(file_id, chunk_idx, start_s, end_s, vec)` for temporal localization inside long files.
  - `user_data`: `(file_id, favorite, user_tags, note)`, isolated so re-indexing never clobbers user annotations.
- **Search (`backend/search.py`):** Parses inline filters (`dur:`, `loop:`, `fmt:`, `tag:`, `fav:`, exclusions, phrases), embeds query text (with an LRU cache), runs KNN over `chunks` (grouped by `file_id` retaining max similarity and best `start_s`) and BM25 over `files.search_text` with pushed-down scalar filters, and merges results via Reciprocal Rank Fusion (`k = 60`). Supports empty-query library browsing (`SfxStore.browse_file_ids`), `offset`/`limit` pagination with total counts (`search_page`), sort modes (`relevance`, `name_asc`, `name_desc`, `duration_asc`, `duration_desc`, `lufs_desc`, `lufs_asc`), `audio_only`, `keyword_only`, and file/chunk/upload similarity search.
- **HTTP API (`backend/api.py`) & Web UI (`web/`):** FastAPI app bound to `127.0.0.1:8765` serving search, similarity, metadata, waveform peaks, user annotations, single-file edited asset saving/indexing (`/api/files/{file_id}/save-edited`) and output encoding to WAV/FLAC/MP3/Ogg/Opus via ffmpeg (`save-edited`, `/api/transcode`; [ADR 0006](../adr/0006-studio-output-encoding-via-backend-ffmpeg.md)), background library root indexing, native Windows folder picking, Windows Explorer reveal, and HTTP Range audio streaming (with on-the-fly ffmpeg transcoding + disk cache for browser-incompatible formats). The React + TypeScript + Vite SPA uses the `dyvoided.2` token/component system (`web/src/design-system/`), continuous mirror-envelope `MiniWaveform` canvases (lazy-loaded via `IntersectionObserver`), a Web Audio 16-band FFT spectrum analyzer, infinite scroll, and a dedicated **Edit Mode / Audio Studio (`web/src/editor/`)** with modular client-side DSP (`Seamless Loop` with Web Worker auto-loop search, crossfade baking, and real-time seam scope; `Trim & Gain`; `3-Band Parametric EQ`; and `Variations & Export`).
- **MCP Server (`backend/mcp_server.py`):** Exposes `search_sounds`, `batch_search`, `find_similar`, `get_sound`, and `library_stats` over stdio and local HTTP directly against LanceDB without requiring the FastAPI server to run.
- **Evaluation Harness (`backend/eval/`):** Runs benchmark query sets (`eval/queries.yaml`) with path/glob relevance judgments across config variants, outputting Recall@10, Recall@50, MRR, and nDCG@20 to `eval/runs/`.

## Data / control flow

1. **Indexing:** `sfxsearch index` scans roots -> diffs manifest -> queues changed files -> CPU workers decode PCM + extract tags/features -> GPU batches 32 audio windows through CLAP -> commits every 200 files to LanceDB.
2. **Text Search:** Query string -> parse inline filters -> `embed_text` (LRU cached) -> parallel LanceDB chunk vector search + `files` BM25 FTS search with pre-filtering -> group chunks by `file_id` (keep max score + `start_s`) -> RRF merge -> join `user_data` -> return ranked hits.
3. **Auditioning:** UI renders results list -> user presses Space or clicks row -> browser requests `/api/audio/{file_id}` with HTTP `Range` starting at `best_offset_s` -> API streams native file or cached ffmpeg transcode.

## Stack structure

```
sfx-search/
  backend/            Python package `sfxsearch` (managed via uv, pyproject.toml)
    cli.py            Typer CLI entry points
    config.py         Pydantic settings loaded from config.toml
    scan.py           Recursive walker + manifest diffing
    decode.py         ffmpeg/ffprobe subprocess wrappers
    metadata.py       Container tags, BWF bext, iXML, path tokenizer
    features.py       LUFS, peak dBFS, loop score
    embed.py          CLAP model wrapper (audio windows + text)
    store.py          LanceDB schema, batch upserts, FTS/vector queries
    search.py         Hybrid retrieval, RRF fusion, similarity search
    api.py            FastAPI endpoints, Range streaming, transcode cache
    mcp_server.py     MCP server tools
    eval/             Evaluation runner and metrics
  web/                React + TypeScript + Vite + dyvoided.2 design system frontend
  .github/workflows/  GitHub Actions CI (backend + web checks on main & PRs)
  start.bat           Windows one-step install, build, and launch script
  start.sh            Shell one-step install, build, and launch script
  eval/               queries.example.yaml and eval/runs/ outputs
  config.example.toml Reference configuration
```

## Constraints

- **100% local and offline:** No cloud APIs or external network calls after Hugging Face model weights are cached locally.
- **Hardware budget:** Must run comfortably on an 8 GB VRAM NVIDIA GPU (RTX 2080 Super class) without OOMs; decode queue and GPU batch size (default 32 in `fp16`) must remain bounded.
- **Deterministic window embeddings:** CLAP preprocessing must never randomly crop windows. Embedding the exact same 10 s window twice must yield identical vectors.
- **Model consistency:** Mixing embeddings from different checkpoints or dimensions in one LanceDB database is forbidden; `store.py` must verify `embedding_model` and `embedding_dim` on startup.
- **Windows filesystem realities:** Must handle Unicode paths, paths exceeding `MAX_PATH` (260 chars), and case-insensitive forward-slash path normalization.
- **Fault isolation during indexing:** Corrupt or undecodable audio files are recorded in `files` with `status = error` and the error message; they must never abort a multi-hour indexing run.

## Decisions

The reasoning behind specific choices lives in the [ADR log](../adr/). Start there before changing
anything structural.
