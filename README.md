# sfx-search

A local, offline search engine for large personal sound-effects libraries (30-100 GB) using natural-language descriptions (CLAP audio-text embeddings), hybrid keyword ranking (BM25 + RRF), and audio similarity, with a fast auditioning web UI and an MCP server.

## Status

Early prototype. Things will change and break.

## Requirements

- Windows 10/11
- Python 3.11+ and [`uv`](https://docs.astral.sh/uv/)
- NVIDIA GPU with 8 GB+ VRAM (CUDA-enabled PyTorch)
- `ffmpeg` and `ffprobe` on `PATH` (or configured in `config.toml`)
- Node.js 20+ and `npm` (for `web/`)

## Getting Started

```powershell
# 1. Install Python dependencies
uv sync

# 2. Create local configuration
Copy-Item config.example.toml config.toml

# 3. Index a sound library folder
uv run sfxsearch index "D:/SFX"

# 4. Run a CLI search
uv run sfxsearch search "slow wooden floor creak, large empty house"

# 5. Start the API server (serves on http://127.0.0.1:8765)
uv run sfxsearch serve

# 6. Start the web UI in development mode
cd web
npm install
npm run dev
```

## Project Structure

```
backend/         Python package `sfxsearch` (CLI, indexer, LanceDB store, FastAPI, MCP, eval)
web/             React + TypeScript + Vite auditioning frontend
eval/            Evaluation queries and benchmark runs
docs/            Architecture, ADRs, roadmap, and git workflow
build_spec.md    Full system specification and acceptance criteria
AGENTS.md        Context and instructions for AI agents
PICKUP.md        Session handoff state
```

## Documentation

- [Build Specification](build_spec.md)
- [Architecture Overview](docs/architecture/overview.md)
- [Architecture Decisions](docs/adr/)
- [Roadmap](docs/ROADMAP.md)
- [Git Strategy](docs/git-strategy.md)
