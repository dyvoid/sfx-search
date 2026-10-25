# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Sound designers and game-audio practitioners — solo professionals managing a large personal sound-effects library (30–100 GB+, mixed formats, uneven metadata). They work fast, on a keyboard, often mid-session in a DAW, and need a sound found and shaped in seconds, not minutes.

## Product Purpose

Find the right sound in a large local library by describing it or by audio similarity — then shape it into a production-ready asset (trim, EQ, seamless loop, round-robin variations) without leaving the browser. Success means: type a phrase, audition candidates instantly, tweak or generate takes, and drag the result straight into the DAW.

## Positioning

A local, fully offline librarian-plus-workbench for personal SFX collections. Unlike cloud SFX browsers (Splice, Soundly) it indexes *your* files on *your* GPU and never phones home; unlike desktop librarians (BaseHead) it does semantic text+similarity retrieval *and* ships a real-time non-destructive edit studio in the same surface.

## Operating Context

- Local Windows workstation, NVIDIA GPU (~8 GB VRAM), `ffmpeg` on PATH; library lives on local drives
- Keyboard-first auditioning in the library; module-based DSP rack in the studio
- Drag-to-DAW is the delivery ritual; edited files save back into the indexed library
- Also reachable via CLI and MCP server for LLM clients

## Capabilities and Constraints

- Hybrid retrieval (CLAP embeddings + BM25, RRF), inline query syntax, similarity search, background indexing
- In-browser DSP studio: Trim & Gain, Tone & EQ, Seamless Loop (auto candidates, crossfade, seam scope), Variations round-robin takes; bake/download and save-to-library
- Dark-only UI, dyvoided.2 design system, compact density for power use
- Confirmed durable constraint: **offline, personal, free** — local-first is a commitment, not just current architecture; no cloud services, accounts, telemetry, or paid features

## Brand Commitments

- Name: `sfx-search`
- Visual identity: dyvoided.2 (see DESIGN.md) — graphite neutrals, category-assigned accents
- Voice: literal, terse, technical; mono micro-labels; no emoji, no exclamation points

## Evidence on Hand

- The user's real SFX library on local drives (do not fabricate demo content)
- `build_spec.md`, `docs/` (architecture, ADRs, roadmap) as product record

## Product Principles

- Speed of audition over breadth of features
- Local-first and offline — the GPU is the backend
- Library → studio → DAW is one pipeline, never three tools
- Keyboard is the primary interface; mouse is secondary
- Machine proposes (candidates, takes, matches); the user decides

## Accessibility & Inclusion

Keyboard-first operation is a product requirement, not a courtesy: all primary actions reachable without a pointer, visible focus states, named controls.
