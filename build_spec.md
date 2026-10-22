# sfx-search: Build Spec

A local, offline tool for searching a large personal sound-effects library (30-100 GB, mixed formats, mixed metadata quality) by text description and by audio similarity, with a web UI for auditioning results and an MCP endpoint for programmatic querying.

Target environment: Windows, Python 3.11+, NVIDIA GPU with 8 GB VRAM (RTX 2080 Super class), ffmpeg available on PATH or via config. Everything runs locally; no network access is required after model weights are downloaded.

---

## 1. Goals

1. Natural-language search over audio content ("slow wooden floor creak, large empty house") using a joint text-audio embedding model.
2. Hybrid ranking that combines audio-embedding similarity with keyword matching over filenames, folder paths, and embedded tags.
3. Hard filters on duration, loudness, sample rate, channel count, format, and source folder.
4. Find-similar from any result or from any dropped-in reference file.
5. A web UI optimized for fast auditioning: instant playback, waveform with a marker at the best-matching moment, keyboard navigation, favorites and tags.
6. An MCP server exposing the same search to LLM clients.
7. A repeatable evaluation harness so model, chunking, and fusion choices are measured on real queries.

### Scope boundaries

Out of scope: cloud services, audio editing, DAW integration, sound generation, multi-user access, license tracking.

---

## 2. Architecture

```
sfx-search/
  backend/            Python package `sfxsearch`
    cli.py            Typer CLI: index, search, similar, serve, eval, stats
    config.py         Pydantic settings, loaded from config.toml
    scan.py           Library walker + manifest diffing
    decode.py         ffmpeg/ffprobe wrappers
    metadata.py       Tag, filename, and path extraction
    features.py       Duration, loudness, peak, loop estimate
    embed.py          CLAP embedder (text + audio windows)
    store.py          LanceDB tables and queries
    search.py         Hybrid retrieval and rank fusion
    api.py            FastAPI app
    mcp_server.py     MCP tools over the search layer
    eval/             Evaluation harness
  web/                Vite + React + TypeScript
  config.example.toml
  eval/queries.example.yaml
```

Data flow: **scan -> decode -> (metadata, features, chunk embeddings) -> store -> search -> API/MCP/UI**.

Stack:
- Python backend: FastAPI, Uvicorn, PyTorch (CUDA build), transformers, LanceDB, numpy, soundfile or ffmpeg pipes, pydantic, typer, pyyaml.
- Frontend: TypeScript, React, Vite, wavesurfer.js.
- MCP: official Python MCP SDK, served from the same process family as the API.

---

## 3. Data Model (LanceDB)

### Table `files`
| Column | Type | Notes |
|---|---|---|
| `file_id` | string | Stable hash of normalized absolute path |
| `path` | string | Absolute path, forward-slash normalized |
| `root` | string | Library root the file was found under |
| `size_bytes` | int64 | Manifest key |
| `mtime_ns` | int64 | Manifest key |
| `format` | string | Container/codec |
| `duration_s` | float32 | |
| `sample_rate` | int32 | |
| `channels` | int16 | |
| `lufs_integrated` | float32 | Nullable |
| `peak_dbfs` | float32 | |
| `loop_score` | float32 | Nullable, experimental |
| `tags_json` | string | Raw extracted tags (BWF/iXML/ID3/etc.) |
| `search_text` | string | Concatenated, normalized filename, folder tokens, and tag text. Full-text indexed |
| `file_vec` | vector(dim) | Mean of chunk vectors, L2-normalized |
| `embedding_model` | string | Model id used |
| `status` | string | `ok`, `error`, `missing` |
| `error` | string | Nullable |
| `indexed_at` | timestamp | |

### Table `chunks`
| Column | Type | Notes |
|---|---|---|
| `file_id` | string | |
| `chunk_idx` | int32 | |
| `start_s` | float32 | |
| `end_s` | float32 | |
| `vec` | vector(dim) | L2-normalized |

### Table `user_data` (separate so re-indexing never overwrites it)
| Column | Type |
|---|---|
| `file_id` | string |
| `favorite` | bool |
| `user_tags` | list<string> |
| `note` | string |

Every record stores `embedding_model` and the table metadata stores `embedding_dim`. The indexer refuses to mix models inside one database and prints a clear message if the configured model differs from the stored one.

---

## 4. Indexer

### 4.1 Scanning and resumability
- Walk configured roots recursively for: `.wav .flac .aif .aiff .mp3 .ogg .opus .m4a .wma .aac`. Extension list is configurable.
- Manifest key per file: `(normalized path, size_bytes, mtime_ns)`.
- New or changed files are (re)indexed. Unchanged files are skipped. Files present in the database but missing on disk get `status = missing` and are excluded from search by default.
- The run is safe to interrupt at any point. Work is committed in batches (default every 200 files), and a restart continues from the manifest.
- Windows requirements: handle unicode paths, paths longer than 260 characters (use extended-length prefix where needed), and case-insensitive path normalization.

### 4.2 Decoding
- Decode with an ffmpeg subprocess to 48 kHz, mono, float32 PCM, streamed through a pipe.
- Collect `ffprobe -show_format -show_streams -of json` output for duration, sample rate, channel count, codec, and container tags.
- A file that fails to decode is recorded with `status = error` and the error message, and the run continues.
- Decode runs in a worker pool (default: CPU count minus 2) feeding a bounded queue to the GPU stage so the GPU is never starved and memory stays bounded.

### 4.3 Chunked embeddings
The embedder consumes fixed windows so that every part of a long file contributes to the index.

- Window length: 10 s. Hop: 5 s (configurable).
- Files shorter than 10 s produce a single chunk using the model's repeat-padding behavior.
- Maximum chunks per file (default 120). For files that would exceed this, the hop is increased so chunks span the whole file evenly.
- Each window is passed to the model so that no random cropping occurs (windows are at most the model's native input length). Embedding the same window twice must return identical vectors; the test suite asserts this.
- Run the model in batches (default 32 windows) under `torch.inference_mode()`. Support `fp16` and `fp32` via config.
- Default checkpoint: `laion/larger_clap_general` (512-d). The model id is a config value. Normalize all vectors to unit length.
- `file_vec` is the L2-normalized mean of that file's chunk vectors.

### 4.4 Metadata extraction
- Container tags via ffprobe (covers ID3, Vorbis comments, many BWF fields).
- BWF `bext` and iXML chunks parsed from WAV files (description, originator, category, subcategory, keywords, UCS-style fields when present).
- Filename tokens: split on `_ - . space` and camelCase; drop pure numeric tokens and common noise ("final", "v2", "copy").
- Folder tokens: the last 3-4 path components, tokenized the same way.
- `search_text` is the concatenation of all of the above, lowercased, with tags weighted by repetition-free simple concatenation (ranking weights are handled at query time).

### 4.5 Acoustic features
- Integrated loudness (LUFS) and true/sample peak, computed from the decoded array.
- Loop estimate (experimental, nullable): similarity between the spectral content of the first and last 500 ms plus waveform continuity at the boundary. Exposed as `loop_score` in `[0, 1]`.

### 4.6 CLI
```
sfxsearch index <root> [<root> ...] [--limit N] [--reindex] [--model ID] [--fp16/--fp32]
sfxsearch search "query" [-k 20] [--min-dur S] [--max-dur S] [--json]
sfxsearch similar <path-or-file_id> [-k 20]
sfxsearch serve [--host 127.0.0.1] [--port 8765]
sfxsearch eval <queries.yaml> [--config-variant NAME]
sfxsearch stats
```
`index` prints throughput (files/min, audio-hours/min), ETA, error counts, and GPU memory use.

---

## 5. Search

### 5.1 Pipeline
1. Embed the query text (`embed_text`), producing a unit vector.
2. **Vector leg:** KNN over `chunks` (default top 300 chunks), then group by `file_id`, keeping the maximum similarity per file and remembering the `start_s` of the best chunk.
3. **Keyword leg:** BM25 full-text search over `files.search_text` (default top 100 files).
4. **Fusion:** Reciprocal Rank Fusion over the two ranked file lists with `k = 60`. Each result carries its component scores (`clap_score`, `bm25_score`, `rrf_score`) for display and debugging.
5. **Filters** (duration range, LUFS range, sample rate, channels, formats, root folder, favorites only, minimum loop score) are pushed down into both legs.
6. Return the top N with file metadata, best-chunk offset, and user data.

Fusion weights and leg depths are config values and are evaluated through the harness.

### 5.2 Modes
- `hybrid` (default), `audio_only` (vector leg only), `keyword_only` (BM25 only).
- Query syntax: plain text. Quoted phrases and `-term` exclusions apply to the keyword leg only. Optional inline filters such as `dur:2-8` and `loop:true` are parsed out before embedding.

### 5.3 Find similar
- Input: a `file_id` (optionally with a `chunk_idx`) or an uploaded or dropped reference file.
- File mode compares `file_vec` against `file_vec`. Chunk mode compares one chunk vector against all chunks and groups by file.
- An uploaded reference is embedded with the same windowing and mean pooling as indexed files.

### 5.4 Query embedding cache
LRU cache of recent query vectors so repeated or incremental typing is instant.

---

## 6. HTTP API (FastAPI)

Bind to `127.0.0.1` by default.

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/search` | Query + filters + mode, returns results |
| GET | `/api/similar/{file_id}` | Find similar (`chunk` query param optional) |
| POST | `/api/similar/upload` | Find similar from an uploaded reference file |
| GET | `/api/files/{file_id}` | Full metadata for one file |
| GET | `/api/audio/{file_id}` | Audio stream with HTTP Range support |
| GET | `/api/peaks/{file_id}` | Precomputed waveform peaks (cached on disk) |
| PUT | `/api/files/{file_id}/user` | Set favorite, tags, note |
| POST | `/api/files/{file_id}/reveal` | Reveal the file in Windows Explorer |
| GET | `/api/stats` | Library counts, model, index state |
| GET | `/api/filters` | Available formats, roots, duration/LUFS ranges |

Requirements:
- `/api/audio` supports byte-range requests so seeking and instant playback work for large files. Formats a browser cannot play natively (e.g., some AIFF, high-bit-depth or multichannel WAV) are transcoded on the fly to a browser-playable stream (for example 48 kHz stereo AAC or WAV 16-bit), with a small on-disk cache.
- Responses include `Cache-Control` headers appropriate for local use.
- Static web build is served by the same app in production mode; Vite dev server proxies `/api` in development.

---

## 7. Web UI (React + TypeScript)

Single-page app focused on speed of auditioning.

- **Search bar** with mode selector and a collapsible filter panel (duration, loudness, format, folder, favorites, loop score).
- **Results list**: file name, folder path, duration, format, score breakdown on hover, a mini waveform, and a marker showing the best-matching moment.
- **Playback**: one-click play on a row, starts at the best-chunk offset by default (toggle to start from 0). Arrow keys move between results, Space plays/pauses, Enter opens the detail panel. Only one sound plays at a time. Optional loop toggle.
- **Detail panel**: full waveform (wavesurfer.js) with click-to-seek and region selection, full metadata and raw tags, user tags and notes, "Find similar" for the whole file or the selected region's chunk, "Reveal in folder", "Copy path".
- **Find similar from file**: drag-and-drop a reference audio file anywhere in the window.
- **Favorites and tags**: toggle favorite from the list, filter by favorites and by user tag.
- **Query history** (local storage) and the last used filters.
- Layout is responsive, with a dark theme by default.

---

## 8. MCP Server

Tools exposed over MCP (stdio and local HTTP transports):

| Tool | Arguments | Returns |
|---|---|---|
| `search_sounds` | `query`, `k`, `mode`, filters | Ranked list: `file_id`, `path`, `duration_s`, tags summary, scores, `best_offset_s` |
| `batch_search` | `queries: string[]`, shared filters, `k` | One ranked list per query |
| `find_similar` | `file_id` or `path`, `k` | Ranked list |
| `get_sound` | `file_id` | Full metadata |
| `library_stats` | none | Counts, model, filters available |

Results are compact text-friendly JSON. The server reads the same LanceDB database as the API and does not require the API to be running.

---

## 9. Evaluation Harness

`eval/queries.yaml`:

```yaml
- id: floor-creak
  query: slow wooden floor creak, large empty house
  relevant:
    - "D:/SFX/Foley/Wood/**/creak_floor_*.wav"
    - "D:/SFX/Pack X/Doors/old_floorboard_03.wav"
  notes: Prefer longer, low-pitched creaks
```

- `relevant` entries are exact paths or globs marking acceptable results.
- Metrics: Recall@10, Recall@50, MRR, nDCG@20, reported per query and as a mean.
- `config variants` (named sets of overrides) let one run compare models, window/hop, fp16 vs fp32, fusion depth, and search mode. Output is a markdown table plus a JSON file, saved under `eval/runs/`.
- A `--show-misses` flag lists the top results for queries below a recall threshold so the failure can be inspected by ear.

---

## 10. Configuration (`config.toml`)

```toml
[library]
roots = ["D:/SFX"]
extensions = [".wav", ".flac", ".aif", ".aiff", ".mp3", ".ogg", ".opus", ".m4a"]

[paths]
data_dir = "./data"
ffmpeg = "ffmpeg"
ffprobe = "ffprobe"

[embedding]
model_id = "laion/larger_clap_general"
precision = "fp16"        # fp16 | fp32
window_s = 10
hop_s = 5
max_chunks_per_file = 120
batch_size = 32

[indexing]
decode_workers = 6
commit_every_files = 200

[search]
vector_candidates = 300
keyword_candidates = 100
rrf_k = 60
default_k = 30

[server]
host = "127.0.0.1"
port = 8765
```

---

## 11. Milestones and Acceptance Criteria

### M1: Indexer + CLI search
- Index a subset of the library (point at 2-3 folders) end to end, resumable and interruptible.
- `sfxsearch search` returns ranked results with component scores.
- Tests: window embedding determinism, manifest diffing, chunk-count cap, Windows path handling, error-file handling.
- Report throughput (audio-hours per hour) and VRAM use on the target GPU.

### M2: Evaluation and tuning
- Eval harness working with at least 20 real queries.
- Compare: fp16 vs fp32; window/hop variants; hybrid vs audio-only vs keyword-only; at least one alternative embedding checkpoint.
- Produce a short results table and pick defaults.

### M3: API + Web UI
- All endpoints in section 6, with Range-based streaming and transcoding fallback.
- UI features in section 7, including keyboard navigation and drag-and-drop find-similar.

### M4: MCP + full-library run
- MCP tools in section 8, verified against a real MCP client.
- Full library indexed; `stats` shows counts, errors, and total audio duration.
- README with setup (CUDA PyTorch, ffmpeg, first run, config), usage, and troubleshooting.

---

## 12. Items To Verify During the Build

These were not verified in advance and should be checked or measured early:

1. The chosen checkpoint's preprocessor configuration (max length, truncation, padding) matches the assumptions in section 4.3. Assert it at startup.
2. fp16 and fp32 embeddings agree closely (cosine similarity of paired vectors on a sample), and retrieval quality is equivalent on the eval set.
3. Indexing throughput on the target GPU and the resulting total index time for the full library.
4. LanceDB full-text search behavior and index build on Windows, including incremental updates.
5. FastAPI/Starlette Range-request behavior for large files and the transcoding path for formats browsers cannot play.
6. Whether the loop estimate correlates with listening judgment; keep it optional if it does not.
7. Embedding-dimension and model-id consistency checks when switching checkpoints.