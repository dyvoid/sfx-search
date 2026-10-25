# AGENTS.md

This file is the primary context source for AI agents working in this repository. Read it before
doing anything else, and follow the instructions here. For deeper context on a specific topic,
follow the links in the index at the bottom.

This is the one place that governs how AI agents behave in this repo. The linked docs carry context
and decisions; they deliberately avoid AI-specific instructions so there's no second source of truth.

**Before doing any git work** (commits, branches, merges) **read [Git Strategy](docs/git-strategy.md)
in full.** Do not commit, branch, or merge based on assumption or partial recollection of the rules.

---

## Project Overview

`sfx-search` is a local, offline tool for searching a large personal sound-effects library (30-100 GB, mixed formats, mixed metadata quality) by natural-language text description and by audio similarity. It provides a CLI, a FastAPI backend, a React/Vite web UI for fast auditioning plus an in-browser sound-design studio (Trim & Gain, Tone & EQ, Seamless Loop, Variations round-robin takes — all client-side DSP on a decoded copy, with bake/download and save-back-into-library), an MCP server for LLM clients, and an evaluation harness for measuring retrieval quality. It is currently an early prototype targeting a local Windows workstation with an 8 GB VRAM NVIDIA GPU (RTX 2080 Super class) and `ffmpeg` on PATH.

---

## Architecture

The system runs locally in two main parts: a Python backend (`sfxsearch`) and a React/TypeScript web frontend (`web/`). The indexer walks configured audio roots, decodes files to 48 kHz mono float32 PCM via `ffmpeg` worker pools, extracts container/BWF/iXML tags and acoustic features (LUFS, peak, loop score), embeds 10s/5s overlapping audio windows with a CLAP model (`laion/larger_clap_general`), and stores records in LanceDB (`files`, `chunks`, and `user_data` tables). Search runs a hybrid pipeline combining KNN over chunk vectors and BM25 full-text search over normalized metadata via Reciprocal Rank Fusion (RRF), exposed through the CLI, FastAPI HTTP endpoints, and an MCP server. The web app's Studio (`web/src/editor/`) decodes a file client-side and runs a real-time DSP chain (crop/gain, biquad EQ, loop crossfade, pitch/volume take variations) with an auto loop-candidate finder in a Web Worker; only the final bounce touches the backend via `POST /api/files/{id}/save-edited` (plus drag-out `.wav` blobs for DAW import).

See [Architecture Overview](docs/architecture/overview.md) for the full picture, [the Build Spec](build_spec.md) for detailed component requirements, and [the ADR log](docs/adr/) for the reasoning behind specific decisions.

---

## AI Instructions

### You can do these freely
- Write, edit, and refactor code that follows the patterns already in the codebase
- Create new files consistent with existing conventions
- Update documentation to match code changes
- Add tests for new or existing functionality

### These need human review before they land
- `.gitignore` and `.gitattributes`
- Authentication, authorization, or anything touching secrets
- Dependency changes (lockfiles, package manifests)
- Refactors that cut across multiple modules
- CI/CD configuration

### Do not do these
- Commit directly to `main`, except the two cases in [Git Strategy](docs/git-strategy.md#branch-protection)
  (non-functional changes, or explicit user sign-off for this change)
- Delete or rename files without being asked
- Change architecture without recording an ADR in `docs/adr/`
- Add third-party dependencies outside the build spec without explicit instruction

---

## Conventions

### Branching
Short-lived branches only: `task/`, `fix/`, `experiment/`. Details in [Git Strategy](docs/git-strategy.md).

### Commits
One commit per task or prompt session. [Conventional Commits](https://www.conventionalcommits.org).
Put AI context in the body, not the subject:

```
feat(scope): short imperative summary

ai-assisted: <model>
```

### Python (`backend/`) specifics
- **Runtime & dependency manager:** Python 3.11+ managed with `uv`. Commit `uv.lock`; never commit `.venv/`. Agents must not switch package managers or Python versions without being asked.
- **Core stack:** FastAPI, Uvicorn, PyTorch (CUDA build), `transformers`, LanceDB, `numpy`, `soundfile` / `ffmpeg` pipes, `pydantic`, `typer`, `pyyaml`, official Python MCP SDK.
- **Lint/format/type-check:** `ruff` + `black` + `mypy`. Run these before considering Python changes done.
- **Type hints:** Required on every function, public and private.
- **Hardware & VRAM:** The baseline target in `build_spec.md` is Windows with an 8 GB VRAM GPU (RTX 2080 Super class), batch size 32, and `fp16` inference under `torch.inference_mode()`. The user's machines vary; ask before changing VRAM budgets, batch sizes, or model checkpoints.
- **Windows paths:** Always handle Unicode paths, extended-length paths (>260 chars), and case-insensitive forward-slash path normalization when computing `file_id` or manifest keys.

### Web (`web/`) specifics
- **Package manager:** `npm` only. Commit `package-lock.json`; do not mix package managers.
- **Core stack:** TypeScript (strict), React, Vite, `dyvoided.2` CSS token/component design system (`web/src/design-system/`), `lucide-react`. Waveforms/scopes are custom canvas renderers (`EditorWaveform`, `MiniWaveform`, `SeamScope`, `SpectrumMeter`). Do not introduce another UI framework or styling system unprompted.
- **Controls:** Prefer the kit's compound structures (`ds-*` classes) over re-skinning native inputs — e.g. sliders render `ds-slider-track/fill/knob` + transparent `<input type="range">` via `web/src/components/DsRange.tsx`, and selects go through `DsSelect.tsx`.
- **Accent semantics (app-wide convention):** `--primary` = user intent (actions, selection, focus); `--accent-2` = live audio signal (waveforms, meters, playing state); `--accent-1` = processing (fades, pitch, EQ); `--accent-3` = machine-proposed (match regions, loop candidates, generated takes, analysis progress); `--success/--danger/--warning` = status & level only. Accents are assigned by category, never per-element or per-channel.
- **Build & verification:** `npm run build` (`tsc -b && vite build`) inside `web/`.
- **UX & accessibility constraints:** Keyboard-first auditioning (`Up`/`Down` arrows navigate results, `Space` plays/pauses, `R` reveals file in Explorer, `F` toggles favorite, `Enter` toggles inspector panel, `/` focuses search), single active audio stream at a time, dark theme by default, instant playback at best-chunk offset via HTTP Range requests, infinite scroll with viewport-lazy `MiniWaveform` rendering.

---

## Document Index

| Document | What it covers |
|---|---|
| [Build Spec](build_spec.md) | Full functional specification, schemas, CLI, API, MCP, and milestones |
| [Architecture Overview](docs/architecture/overview.md) | System structure, key components, data flow, and constraints |
| [ADR Log](docs/adr/) | Architecture decisions and their rationale |
| [Roadmap](docs/ROADMAP.md) | Milestones M1-M4, verification items, and status |
| [Git Strategy](docs/git-strategy.md) | Branching, merging, commit rules, and CI expectations |
| [PICKUP](PICKUP.md) | Where the last session left off (active work only, not the backlog) |
