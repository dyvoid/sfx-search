# sfx-search

A local, offline search engine for large personal sound-effects libraries (30-100 GB) using natural-language descriptions (CLAP audio-text embeddings), hybrid keyword ranking (BM25 + Reciprocal Rank Fusion), and audio similarity, with a fast auditioning web UI and an MCP server.

## Status

All four milestones (M1-M4) implemented and verified on Windows + CUDA (`laion/larger_clap_general`).

## Requirements

- Windows 10/11
- Python 3.11+ and [`uv`](https://docs.astral.sh/uv/)
- NVIDIA GPU with 8 GB+ VRAM (CUDA-enabled PyTorch configured via `pyproject.toml`)
- `ffmpeg` and `ffprobe` on `PATH` (or configured in `config.toml`)
- Node.js 20+ and `npm` (for building/developing `web/`)

## Getting Started

```powershell
# 1. Install Python dependencies (includes CUDA PyTorch)
uv sync --extra dev

# 2. Create local configuration
Copy-Item config.example.toml config.toml

# 3. Index one or more sound library folders
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
uv run ruff check backend tests
uv run black --check backend tests
uv run mypy backend tests
uv run pytest -v -p no:cacheprovider
```

## Troubleshooting

- **Model mismatch error on index/search:** `sfx-search` refuses to mix embeddings from different checkpoints in one database. Pass `--reindex` to `sfxsearch index` to rebuild the tables with the new model, or point `paths.data_dir` in `config.toml` to a new directory.
- **Browser cannot play high-bit-depth WAV / multichannel / AIFF files:** The `/api/audio/{file_id}` endpoint automatically detects non-browser-native formats and transcodes them on the fly to a cached 48 kHz 16-bit PCM WAV stream with full HTTP `Range` support.

## Project Structure

```
backend/            Python package `sfxsearch`
  cli.py            Typer CLI: index, search, similar, serve, eval, stats
  config.py         Pydantic settings loaded from config.toml
  scan.py           Library walker, Windows long/unicode paths, manifest diffing
  decode.py         ffmpeg/ffprobe subprocess wrappers
  metadata.py       Container tags, BWF bext, iXML, and path/filename tokenizer
  features.py       Duration, integrated LUFS, peak dBFS, loop score, waveform peaks
  embed.py          Deterministic 10s/5s CLAP embedder + LRU query cache
  indexer.py        Multi-worker CPU decode + GPU batch indexer
  store.py          LanceDB tables (files, chunks, user_data) and FTS/KNN queries
  search.py         Hybrid retrieval, inline query parser, RRF fusion, similarity
  api.py            FastAPI HTTP server + HTTP Range audio streaming + transcode cache
  mcp_server.py     MCP server (search_sounds, batch_search, find_similar, get_sound, library_stats)
  eval/harness.py   Evaluation harness (Recall@10/50, MRR, nDCG@20, variant comparison)
web/                React + TypeScript + Vite + Tailwind CSS v4 + wavesurfer.js SPA
tests/              Unit and integration test suite
docs/               Architecture, ADRs, roadmap, and git workflow
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
