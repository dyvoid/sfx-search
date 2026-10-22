# PICKUP

Where the last session left off. Update this when you stop, so the next session starts with context
instead of archaeology.

## Current focus

Project boilerplate and architecture documentation initialized from `build_spec.md`. Ready to begin **M1: Indexer + CLI search**.

## State

- **Done:**
  - `build_spec.md` authored with full architecture, LanceDB schema, indexer pipeline, hybrid RRF search, FastAPI endpoints, React UI, MCP server, and eval harness specs.
  - Project scaffold generated (`AGENTS.md`, `README.md`, `docs/architecture/overview.md`, `docs/ROADMAP.md`, `docs/git-strategy.md`, ADRs `0001`-`0003`, `.gitignore`, `.gitattributes`).
- **In progress:** None.
- **Not started:** Python package (`backend/` / `pyproject.toml`) and Web app (`web/`).

## Next

1. Create branch `task/m1-project-setup` and initialize `pyproject.toml` (with `uv`), `config.example.toml`, and the `backend/sfxsearch` package skeleton (`config.py`, `cli.py`).
2. Verify item #1 from `build_spec.md` section 12: inspect `laion/larger_clap_general` `ClapFeatureExtractor` parameters (sample rate = 48 kHz, max length = 10 s, padding/truncation) and write a determinism test in `tests/`.
3. Implement `scan.py`, `decode.py`, `metadata.py`, `features.py`, `embed.py`, and `store.py` for Milestone 1.

## Open questions

- Which 2-3 sample folders on `D:/SFX` (or local test fixtures) should be used for the initial M1 benchmark and smoke test?

---
*Last updated: 2026-10-22*
