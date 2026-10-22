# PICKUP

Where the last session left off. Update this when you stop, so the next session starts with context
instead of archaeology.

## Current focus

All milestones (**M1, M2, M3, M4**), UI/UX refinements, large-library infinite scroll + sorting, launcher scripts (`start.bat`, `start.sh`), and GitHub Actions CI (`.github/workflows/ci.yml`) are implemented, tested, and verified.

## State

- **Done:**
  - **M1 (Indexer + CLI):** Implemented `config.py` (with persistent `data/settings.json` roots), `scan.py`, `decode.py`, `metadata.py` (container tags + WAV BWF `bext` + `iXML` + path/camelCase tokenizer), `features.py` (duration, LUFS via `pyloudnorm`, peak dBFS, spectral/boundary `loop_score`, waveform peaks), `embed.py` (deterministic 10s/5s `laion/larger_clap_general` windowing + LRU query cache), `indexer.py` (threaded ffmpeg decode pool + GPU batching + progressive first-file commit), `store.py` (LanceDB `files`, `chunks`, `user_data` + native BM25 FTS + `browse_file_ids` pagination), `search.py` (hybrid RRF, inline filter syntax, `search_page` offset/limit pagination, sort modes, file/chunk/upload similarity), and `cli.py`.
  - **Section 12 Verifications:**
    - `laion/larger_clap_general` preprocessor verified at 48 kHz, 10 s (`480,000` samples), `repeatpad`. Slicing windows to <=10 s guarantees zero random cropping and bit-exact determinism.
    - `fp16` vs `fp32` cosine similarity verified at `> 0.999` for both audio windows and text queries.
    - Indexed 72 local sample audio files in 8.51s (**508 files/min**, **22.4 audio-hours/hour**, **478 MB peak GPU VRAM**).
  - **M2 (Evaluation Harness):** Implemented `backend/eval/harness.py` and `eval/queries.example.yaml` (24 queries). Benchmarked `hybrid` (`Recall@10 = 0.9097`, `Recall@50 = 1.0000`, `MRR = 0.8705`), `audio_only`, `keyword_only`, `vec_heavy`, and `kw_heavy`.
  - **M3 (FastAPI + Studio Web UI):** Implemented `backend/api.py` (all search/similarity/library/streaming endpoints, background indexing manager, native Windows folder picker, HTTP `Range` 206 streaming, automatic `ffmpeg` WAV transcoding cache) and `web/` using the `dyvoided.2` design system:
    - Two-tier studio header with a full-width hero search command bar, inline syntax operator pills, search mode selector, sort selector (`Relevance`, `Name A–Z`, `Name Z–A`, `Shortest first`, `Longest first`, `Loudest first`, `Quietest first`), and live 16-band Web Audio FFT spectrum meter.
    - Decluttered result rows with continuous mirror-envelope `MiniWaveform` (viewport-lazy peak loading + pointer-drag scrubbing), per-row Reveal in Explorer (`R`), Find Similar, and Favorite (`F`) actions, and `IntersectionObserver` infinite scroll across large libraries.
  - **M4 (MCP Server):** Implemented `backend/mcp_server.py` (`search_sounds`, `batch_search`, `find_similar`, `get_sound`, `library_stats`) supporting `stdio` and `streamable-http`.
  - **CI & Launchers:** Added `start.bat`, `start.sh`, and `.github/workflows/ci.yml` running backend (`ruff`, `black --check`, `mypy`, `pytest`) and frontend (`npm run build`) checks on pushes and PRs to `main`.

## Next

1. Run `.\start.bat` (or `./start.sh`) to launch the app on `http://127.0.0.1:8765`.
2. Add your sound library folders via the UI **Folders** dialog and audition/search as files index in the background.

## Open questions

- None.

---
*Last updated: 2026-04-20*
