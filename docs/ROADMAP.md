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
| **Studio: Transcoding on Save & Download** | Done | `Save to Library` and `Download` (formerly `Export WAV`) share one dialog with filename and output format: WAV 16/24/32-float, FLAC 16/24, MP3, Ogg Vorbis and Opus with a bitrate. Also used for the Variations batch save/download. Encoding runs in the backend with `ffmpeg`; the last choice is remembered per browser | [ADR 0006](adr/0006-studio-output-encoding-via-backend-ffmpeg.md) |
| **Bug: Studio waveform overflows on gain** | Done | Raising Output Gain past 0 dBFS draws the waveform beyond its lane bounds (into the neighbouring channel and off the canvas) instead of showing it clipped. Expected: samples over full scale are drawn flat at the lane edge and marked as clipping (`--danger`), so the user sees the result will clip | — |
| **Bug: Loop stops after switching candidate** | Done | In Seamless Loop, while a found loop candidate is playing, selecting another candidate whose end point is earlier than the current playhead stops looping: playback runs on to the end of the file and stops. Expected: playback jumps into the new loop region and keeps looping | — |

---

## Archive

_Nothing archived yet._
