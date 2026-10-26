# ADR 0004: Integrated Audio Editor and Modular DSP Pipeline

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

`sfx-search` excels at retrieving and auditioning sound effects across large local libraries, but sound designers almost never drop raw library files straight into an engine or DAW without shaping them first. Turning an ambience or texture into a seamless loop, trimming silence, applying micro-fades, normalizing loudness, or sculpting tone with EQ previously required round-tripping to an external tool or DAW.

Furthermore, we want `sfx-search` to grow into a unified sound-design workstation where the user can transition from library search into a dedicated **Edit Mode** ("Audio Studio") and activate focused processing modules — starting with seamless loop creation (incorporating the DSP and auto-loop search architecture from *Gimme Teh Loop*) and expanding into Trim/Fades, Parametric EQ, and Variations.

## Decision

1. **Dedicated Edit Mode (`StudioView`) with Non-Destructive Module Pipeline:**
   - The Web UI gains a top-level mode switch between **Library** (search/browse) and **Editor** (deep single-file audio workstation), accessible via the `E` shortcut, row action buttons, or the Inspector panel.
   - Audio is fetched from `/api/audio/{file_id}` and decoded client-side via the Web Audio API (`decodeAudioData`) into float32 channel buffers.
   - The editor is structured around a pluggable **Module Rack** (`Loop`, `Trim & Gain`, `EQ`, `Variations`). Each module owns a typed state slice and pure DSP stage operating on `Float32Array[]` channels so modules compose cleanly in a deterministic processing chain:
     `Source PCM -> Trim & Gain -> Parametric EQ -> Seamless Loop Bake -> Preview / Export`.
2. **Seamless Loop Module (Core Module #1):**
   - Incorporates sample-accurate loop baking (`pre`, `post`, `head`, and `auto` crossfade placement with `equal-power`, `cosine`, and `linear` curves) and rising/any zero-crossing snapping.
   - Runs two-stage automatic loop-point detection in a dedicated Web Worker (`search.worker.ts`):
     - **Pair mode** (`findLoopPairs`) when the loop end sits near the file end, scanning a subsampled 3-band RMS envelope (`full`, `<1 kHz`, `>1 kHz`) in $O(n \cdot \text{lag})$ followed by decimated low-pass normalized cross-correlation (NCC) fine alignment on both endpoints.
     - **Fixed-end mode** (`findLoopPoints`) when the user has placed a deliberate loop end marker, finding matching run-up windows before candidate start points.
   - Includes a real-time **Seam Phase & Continuity Scope** that overlays the waveform across the loop boundary (`E -> S`) so phase alignment and crossfade smoothness are visually verifiable alongside live looped Web Audio playback.
3. **Procedural Variations & Round-Robin Generator (Core Module #4):**
   - Synthesizes organic round-robin takes (`variations.ts`) from the active edited/looped buffer without leaving the browser:
     - **Stratified Anti-Clumping Sampling:** Generates $N$ takes across stratified Latin-hypercube slots so no two takes clump at the same pitch/force.
     - **Pitch Shift vs. Zero-Integral Pitch Drift:** Separates static per-take `Pitch Shift` from internal time-varying `Pitch Drift` (normalized so $\int \text{drift}(t)\,dt = 0$, guaranteeing internal spline movement never causes unexpected duration drift), with `Melodic` mode supporting micro-detuning ($\le 45\%$) or scale-step quantization ($> 45\%$).
     - **Protect Start / End (Modulation Masking):** Smoothly masks internal drift and volume modulation at the start and/or end of the sound so initial attack transients stay phase-coherent and tails/loops stay anchored.
     - **Physically-Coupled Tone Variation & Attack Punch:** Continuous `Tone Variation` (`0–100%`) couples strike force to brightness and jitters resonant mid peaks, while `Attack Punch` varies the first ~32 ms transient snap to defeat the machine-gun effect.
     - **Batch Curation:** Individual re-roll, heart/like curation, direct DAW drag-out, and one-click **Save Liked to Library**. (A **Test Sequence** player that cycled through takes back-to-back was later removed: it was not useful enough to keep.)
4. **Save to Library & Immediate Single-File Indexing:**
   - Export supports three workflows without leaving the editor:
     - **Download WAV** (`16-bit`, `24-bit`, or `32-bit float` RIFF/WAVE encoded in-browser).
     - **Drag to DAW / Desktop** (attaching the rendered WAV `File` directly to `DataTransfer` on drag-start).
     - **Save to Library** (`POST /api/files/{file_id}/save-edited`), which writes the rendered WAV into the source file's folder (with collision-safe naming or explicit overwrite), immediately runs single-file decode + feature extraction + CLAP window embedding (`index_single_file`), and copies favorite/user_tags/notes so the new asset is searchable in LanceDB within milliseconds.

## Consequences

- Zero external round-tripping for creating seamless loops, trimming, gain/normalizing, or tonal shaping.
- Client-side Web Audio DSP + Web Worker search keeps the UI at 60 fps and uses zero GPU VRAM during editing.
- The modular `EditorModuleId` and DSP pipeline architecture allows future modules (e.g., multi-band processors, pitch/time variation generators, or backend-assisted neural variations) to plug into the same studio shell, waveform canvas, and export/library-save flow.
