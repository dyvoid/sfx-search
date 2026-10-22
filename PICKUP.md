# PICKUP

Where the last session left off. Update this when you stop, so the next session starts with context
instead of archaeology.

## Current focus

All milestones (**M1, M2, M3, M4**) and all verification items in `build_spec.md` Section 12 are implemented, tested, and verified.

## State

- **Done:**
  - **M1 (Indexer + CLI):** Implemented `config.py`, `scan.py`, `decode.py`, `metadata.py` (container tags + WAV BWF `bext` + `iXML` + path/camelCase tokenizer), `features.py` (duration, LUFS via `pyloudnorm`, peak dBFS, spectral/boundary `loop_score`, waveform peaks), `embed.py` (deterministic 10s/5s `laion/larger_clap_general` windowing + LRU query cache), `indexer.py` (threaded ffmpeg decode pool + GPU batching + resumable manifest diffing), `store.py` (LanceDB `files`, `chunks`, `user_data` + native BM25 FTS), `search.py` (hybrid RRF, inline filter syntax, file/chunk/upload similarity), and `cli.py`.
  - **Section 12 Verifications:**
    - `laion/larger_clap_general` preprocessor verified at 48 kHz, 10 s (`480,000` samples), `repeatpad`. Slicing windows to <=10 s guarantees zero random cropping and bit-exact determinism.
    - `fp16` vs `fp32` cosine similarity verified at `> 0.999` for both audio windows and text queries.
    - Indexed 72 local sample audio files in 8.51s (**508 files/min**, **22.4 audio-hours/hour**, **478 MB peak GPU VRAM**).
  - **M2 (Evaluation Harness):** Implemented `backend/eval/harness.py` and `eval/queries.example.yaml` (24 queries). Benchmarked `hybrid` (`Recall@10 = 0.9097`, `Recall@50 = 1.0000`, `MRR = 0.8705`), `audio_only`, `keyword_only`, `vec_heavy`, and `kw_heavy`.
  - **M3 (FastAPI + React/Vite Web UI):** Implemented `backend/api.py` (all 10 endpoints, HTTP `Range` 206 streaming, automatic `ffmpeg` WAV transcoding cache for AIFF/multichannel/high-bit-depth formats) and `web/` (React + TypeScript + Tailwind v4 + `wavesurfer.js` with Region selection, canvas `MiniWaveform` with best-chunk offset markers, Up/Down/Space/Enter keyboard navigation, drag-and-drop reference audio similarity, favorites, and user tags). Production bundle built into `web/dist/`.
  - **M4 (MCP Server):** Implemented `backend/mcp_server.py` using `MCPServer` (`search_sounds`, `batch_search`, `find_similar`, `get_sound`, `library_stats`) supporting `stdio` and `streamable-http`.
  - **Quality checks:** `ruff`, `black --check`, `mypy`, `pytest` (11/11 passing), and `npm run build` all pass cleanly.

## Next

1. Point `config.toml` (`[library].roots`) at your main 30-100 GB sound library folder and run `uv run sfxsearch index <root>`.
2. Start the server with `uv run sfxsearch serve` and open `http://127.0.0.1:8765` to audition results.

## Open questions

- None.

---
*Last updated: 2026-10-22*
