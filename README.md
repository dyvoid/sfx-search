# sfx-search

[![CI](https://github.com/dyvoid/sfx-search/actions/workflows/ci.yml/badge.svg)](https://github.com/dyvoid/sfx-search/actions/workflows/ci.yml)
![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-3776AB?logo=python&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)
![CUDA](https://img.shields.io/badge/CUDA-fp16%20CLAP-76B900?logo=nvidia&logoColor=white)
![LanceDB](https://img.shields.io/badge/LanceDB-Hybrid%20RRF-6E56CF)
![MCP](https://img.shields.io/badge/MCP-stdio%20%7C%20HTTP-000000)

A local, offline search engine for large personal sound-effects libraries (30–100 GB+) using natural-language descriptions (`laion/larger_clap_general` audio-text embeddings), hybrid keyword ranking (BM25 + Reciprocal Rank Fusion), and audio similarity, with a studio web UI for fast auditioning and an MCP server.

## Features

- **Hybrid Audio + Lexical Retrieval:** Combines 512-d CLAP embeddings over 10s/5s overlapping audio windows with native LanceDB BM25 full-text search over filenames, folder hierarchies, container tags, BWF `bext`, and iXML metadata via Reciprocal Rank Fusion (`k = 60`).
- **Inline Query Syntax & Hard Filters:** Filter inline (`dur:0-2`, `loop:true`, `fmt:wav`, `tag:impact`, `fav:true`, `"exact phrase"`, `-exclusion`) or via the collapsible filter drawer (duration range, integrated LUFS range, format, folder root, loop score, user tag, favorites).
- **Scale-Ready Browsing & Infinite Scroll:** Browse empty queries or filtered views across 10k–100k+ file libraries with `offset`/`limit` pagination, sort modes (`Relevance`, `Name A–Z`, `Name Z–A`, `Shortest first`, `Longest first`, `Loudest first`, `Quietest first`), automatic infinite scroll, and viewport-lazy waveform rendering.
- **Studio Auditioning Workspace:**
  - Continuous anti-aliased mirror-envelope mini-waveforms with pointer-drag scrubbing, best-window highlights on long files, and a real-time 16-band Web Audio FFT spectrum & peak-hold meter.
  - Instant HTTP `Range` (`206 Partial Content`) playback starting at the best-matching 10s window offset, with on-the-fly `ffmpeg` WAV transcoding and disk caching for non-browser-native formats (AIFF, multichannel, 32-bit float).
  - Keyboard-first workflow (<kbd>↑</kbd>/<kbd>↓</kbd> navigate, <kbd>Space</kbd> play/pause, <kbd>R</kbd> reveal in Explorer, <kbd>F</kbd> toggle favorite, <kbd>Enter</kbd> toggle inspector, <kbd>/</kbd> focus search) and drag-and-drop reference audio matching.
- **First-Run Folder Setup & Live Background Indexing:** Add or remove library folders directly from the UI (with native Windows folder picker support); files are decoded and embedded in the background and search unlocks automatically as soon as the first batch commits.
- **MCP Server:** Exposes `search_sounds`, `batch_search`, `find_similar`, `get_sound`, and `library_stats` over `stdio` and `streamable-http`.

## Requirements

- Windows 10/11 (or Linux)
- Python 3.11+ and [`uv`](https://docs.astral.sh/uv/)
- NVIDIA GPU with 8 GB+ VRAM (CUDA-enabled PyTorch configured via `pyproject.toml`; falls back to CPU `fp32` when CUDA is unavailable)
- `ffmpeg` and `ffprobe` on `PATH` (or configured in `config.toml`)
- Node.js 20+ and `npm`

## Quick Start

Run the launcher script to install dependencies, build the web UI, and start the server at `http://127.0.0.1:8765`:

```powershell
# Windows (Command Prompt / PowerShell)
.\start.bat
```

```bash
# Git Bash / Linux / macOS
./start.sh
```

On first launch, add one or more audio folders in the web UI (or via the **Folders** dialog) to start background indexing.

### Manual Setup & CLI Usage

```powershell
# 1. Install Python dependencies (includes CUDA PyTorch)
uv sync --extra dev

# 2. Create local configuration
Copy-Item config.example.toml config.toml

# 3. Index one or more sound library folders from the CLI
uv run sfxsearch index "D:/SFX"

# 4. Search from the CLI
uv run sfxsearch search "slow wooden floor creak, large empty house" -k 20
uv run sfxsearch search "metallic clang dur:0.5-4 -voice" --mode hybrid
uv run sfxsearch similar <file_id-or-path>

# 5. View library statistics
uv run sfxsearch stats

# 6. Run evaluation harness
uv run sfxsearch eval eval/queries.example.yaml -v hybrid -v audio_only -v keyword_only --show-misses

# 7. Build frontend and serve Web UI + HTTP API on http://127.0.0.1:8765
cd web
npm install
npm run build
cd ..
uv run sfxsearch serve
```

### Running the MCP Server

```powershell
# Stdio transport (for Claude Desktop / Windsurf / Devin / Cursor MCP clients)
uv run sfxsearch serve --mcp --mcp-transport stdio

# Streamable HTTP transport
uv run sfxsearch serve --mcp --mcp-transport streamable-http --host 127.0.0.1 --port 8766
```

## Verification & Testing

```powershell
# Python lint, format, type check, and test suite
uv run --extra dev ruff check backend tests
uv run --extra dev black --check backend tests
uv run --extra dev mypy backend tests
uv run --extra dev pytest -v -p no:cacheprovider

# Frontend TypeScript check and production bundle build
cd web
npm run build
```

## Troubleshooting

- **Model mismatch error on index/search:** `sfx-search` refuses to mix embeddings from different checkpoints in one database. Pass `--reindex` to `sfxsearch index` (or click **Rebuild all** in the Folders modal) to rebuild the tables with the new model, or point `paths.data_dir` in `config.toml` to a new directory.
- **Browser cannot play high-bit-depth WAV / multichannel / AIFF files:** The `/api/audio/{file_id}` endpoint automatically detects non-browser-native formats and transcodes them on the fly to a cached 48 kHz 16-bit PCM WAV stream with full HTTP `Range` support.

## Project Structure

```
.github/workflows/  GitHub Actions CI (Python lint/type/test + Web build on main & PRs)
backend/            Python package `sfxsearch`
  cli.py            Typer CLI: index, search, similar, serve, eval, stats
  config.py         Pydantic settings loaded from config.toml + persisted settings.json
  scan.py           Library walker, Windows long/unicode paths, manifest diffing
  decode.py         ffmpeg/ffprobe subprocess wrappers
  metadata.py       Container tags, BWF bext, iXML, and path/filename tokenizer
  features.py       Duration, integrated LUFS, peak dBFS, loop score, waveform peaks
  embed.py          Deterministic 10s/5s CLAP embedder + LRU query cache
  indexer.py        Multi-worker CPU decode + GPU batch indexer with progressive commits
  store.py          LanceDB tables (files, chunks, user_data), browse pagination, and FTS/KNN queries
  search.py         Hybrid retrieval, inline query parser, RRF fusion, sort modes, similarity
  api.py            FastAPI HTTP server, background index manager, HTTP Range streaming, transcode cache
  mcp_server.py     MCP server (search_sounds, batch_search, find_similar, get_sound, library_stats)
  eval/harness.py   Evaluation harness (Recall@10/50, MRR, nDCG@20, variant comparison)
web/                React + TypeScript + Vite + dyvoided.2 design system + wavesurfer.js SPA
tests/              Unit and integration test suite
docs/               Architecture, ADRs, roadmap, and git workflow
start.bat           Windows one-step install, build, and launch script
start.sh            Shell one-step install, build, and launch script
build_spec.md       Full system specification and acceptance criteria
AGENTS.md           Context and instructions for AI agents
PICKUP.md           Session handoff state
```

## Documentation

- [Build Specification](build_spec.md)
- [Architecture Overview](docs/architecture/overview.md)
- [Architecture Decisions](docs/adr/)
- [Roadmap](docs/ROADMAP.md)
- [Git Strategy](docs/git-strategy.md)
