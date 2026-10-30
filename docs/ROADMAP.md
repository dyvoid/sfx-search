# Roadmap

| Feature | Status | Description | ADR |
|---------|--------|-------------|-----|
| **M1: Indexer + CLI Search** | Done | End-to-end resumable indexer (`scan`, `decode`, `metadata`, `features`, `embed`, `indexer`, `store`) and `sfxsearch search` / `similar` / `stats` CLI with unit tests and throughput reporting (~508 files/min, 22.4x realtime, ~478 MB peak VRAM) | [ADR 0002](adr/0002-lancedb-and-hybrid-rrf-search.md), [ADR 0003](adr/0003-chunked-clap-audio-embeddings.md) |
| **Verify: CLAP Determinism & fp16** | Done | Verified `ClapFeatureExtractor` 48 kHz / 10 s `repeatpad` determinism (max diff < `1e-6`) and `fp16` vs `fp32` cosine similarity (> `0.999` on both audio and text) | [ADR 0003](adr/0003-chunked-clap-audio-embeddings.md) |
| **Verify: LanceDB FTS on Windows** | Done | Validated LanceDB native `FTS()` index creation, filter pushdown, and incremental batch rebuilds on Windows | [ADR 0002](adr/0002-lancedb-and-hybrid-rrf-search.md) |
| **M2: Evaluation & Tuning** | Done | Implemented `sfxsearch eval` harness (`Recall@10/50`, `MRR`, `nDCG@20`, `--show-misses`) with 24 queries in `eval/queries.example.yaml` and benchmarked `hybrid`, `audio_only`, `keyword_only`, `vec_heavy`, and `kw_heavy` variants | — |
| **M3: HTTP API + Studio Web UI** | Done | Implemented FastAPI endpoints with HTTP Range streaming, background folder indexing, native folder picker, `offset`/`limit` pagination, sort modes, and React/Vite SPA (`dyvoided.2` design system, continuous mirror-envelope `MiniWaveform`, live FFT spectrum meter, infinite scroll, and keyboard-first auditioning) | — |
| **M4: MCP Server + CI** | Done | Implemented `mcp_server.py` (`search_sounds`, `batch_search`, `find_similar`, `get_sound`, `library_stats`) over stdio and streamable HTTP, one-step launcher scripts (`start.bat`, `start.sh`), and GitHub Actions CI (`.github/workflows/ci.yml`) | — |
| **Audio Studio & Seamless Loop Editor** | Done | Integrated dedicated Edit Mode (`StudioView`) with modular non-destructive DSP (`Seamless Loop` with Web Worker 3-band envelope + fine NCC pair/fixed-end search, crossfade curves, zero-crossing snap, and live seam oscilloscope; `Trim & Gain`; `3-Band Parametric EQ`; Telescope-style `Procedural Variations & Round-Robin Generator` with Foley/Melodic Catmull-Rom pitch/volume splines, formant preservation, EQ randomization, and batch curation; and direct `Save to Library` with instant single-file CLAP indexing + DAW drag-out) | [ADR 0004](adr/0004-integrated-audio-editor-and-loop-module.md) |
| **Studio: Transcoding on Save & Export** | Planned | `Save to Library` and `Export` both offer output format and compression (e.g. WAV bit depth, FLAC, compressed formats with a quality setting) instead of the fixed 24-bit WAV. `Export` gets the same dialog as `Save to Library` (filename, suffix, format) rather than downloading straight away. Open: compressed formats need an encoder; the backend's `ffmpeg` already exists, a browser-side encoder would be a new dependency | — |

---

## Archive

_Nothing archived yet._
