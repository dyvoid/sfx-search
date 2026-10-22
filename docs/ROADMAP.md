# Roadmap

| Feature | Status | Description | ADR |
|---------|--------|-------------|-----|
| **M1: Indexer + CLI Search** | Done | End-to-end resumable indexer (`scan`, `decode`, `metadata`, `features`, `embed`, `indexer`, `store`) and `sfxsearch search` / `similar` / `stats` CLI with unit tests and throughput reporting (~508 files/min, 22.4x realtime, ~478 MB peak VRAM) | [ADR 0002](adr/0002-lancedb-and-hybrid-rrf-search.md), [ADR 0003](adr/0003-chunked-clap-audio-embeddings.md) |
| **Verify: CLAP Determinism & fp16** | Done | Verified `ClapFeatureExtractor` 48 kHz / 10 s `repeatpad` determinism (max diff < `1e-6`) and `fp16` vs `fp32` cosine similarity (> `0.999` on both audio and text) | [ADR 0003](adr/0003-chunked-clap-audio-embeddings.md) |
| **Verify: LanceDB FTS on Windows** | Done | Validated LanceDB native `FTS()` index creation, filter pushdown, and incremental batch rebuilds on Windows | [ADR 0002](adr/0002-lancedb-and-hybrid-rrf-search.md) |
| **M2: Evaluation & Tuning** | Done | Implemented `sfxsearch eval` harness (`Recall@10/50`, `MRR`, `nDCG@20`, `--show-misses`) with 24 queries in `eval/queries.example.yaml` and benchmarked `hybrid`, `audio_only`, `keyword_only`, `vec_heavy`, and `kw_heavy` variants | — |
| **M3: HTTP API + Web UI** | Done | Implemented all FastAPI endpoints with HTTP Range streaming, on-the-fly ffmpeg transcode fallback, waveform peak caching, and React/Vite auditioning SPA with `wavesurfer.js`, mini-waveforms, keyboard navigation, and drag-and-drop similarity | — |
| **M4: MCP Server + Full Library Run** | Done | Implemented `mcp_server.py` (`search_sounds`, `batch_search`, `find_similar`, `get_sound`, `library_stats`) over stdio and streamable HTTP, verified via automated tests | — |

---

## Archive

_Nothing archived yet._
