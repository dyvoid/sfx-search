# Roadmap

| Feature | Status | Description | ADR |
|---------|--------|-------------|-----|
| **M1: Indexer + CLI Search** | In flight | End-to-end resumable indexer (`scan`, `decode`, `metadata`, `features`, `embed`, `store`) and `sfxsearch search` / `similar` / `stats` CLI with unit tests and throughput reporting | [ADR 0002](adr/0002-lancedb-and-hybrid-rrf-search.md), [ADR 0003](adr/0003-chunked-clap-audio-embeddings.md) |
| **Verify: CLAP Determinism & fp16** | Planned | Assert preprocessor padding/truncation behavior (no random crops) and verify `fp16` vs `fp32` cosine similarity and retrieval parity | [ADR 0003](adr/0003-chunked-clap-audio-embeddings.md) |
| **Verify: LanceDB FTS on Windows** | Planned | Validate LanceDB BM25 full-text index creation, filter pushdown, and incremental batch updates on Windows | [ADR 0002](adr/0002-lancedb-and-hybrid-rrf-search.md) |
| **M2: Evaluation & Tuning** | Planned | Build `sfxsearch eval` harness (`Recall@10/50`, `MRR`, `nDCG@20`, `--show-misses`) with 20+ real queries and compare models, window/hop sizes, precision, and fusion weights | — |
| **M3: HTTP API + Web UI** | Planned | FastAPI endpoints with HTTP Range streaming, on-the-fly transcode fallback, waveform peak caching, and React/Vite auditioning SPA with `wavesurfer.js` and keyboard navigation | — |
| **M4: MCP Server + Full Library Run** | Planned | Expose search, batch search, similarity, metadata, and stats over MCP (stdio/HTTP) and index the full 30-100 GB library | — |

---

## Archive

_Nothing archived yet._
