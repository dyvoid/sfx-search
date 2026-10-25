---
name: SFX Search
description: Offline sound-effects search and in-browser sound-design studio
colors:
  intent-indigo: "oklch(48% 0.17 275)"
  transform-amber: "oklch(72% 0.15 55)"
  signal-teal: "oklch(68% 0.10 190)"
  proposal-magenta: "oklch(64% 0.17 345)"
  signature-neutral: "oklch(54.7% 0 0)"
  success: "oklch(62% 0.10 155)"
  danger: "oklch(58% 0.14 25)"
  warning: "oklch(70% 0.115 55)"
  surface-app: "oklch(14% 0.022 260)"
  surface-panel: "oklch(17% 0.02 260)"
  surface-raised: "oklch(18% 0.022 260)"
  surface-sunken: "oklch(12% 0.012 260)"
  text-primary: "oklch(98% 0.005 260)"
  text-secondary: "oklch(74% 0.011 260)"
  text-tertiary: "oklch(63% 0.013 260)"
typography:
  display:
    fontFamily: "Familjen Grotesk, sans-serif"
    fontWeight: 600
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Hanken Grotesk, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.08em"
rounded:
  xs: "2px"
  sm: "2px"
  md: "4px"
  lg: "6px"
  full: "999px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  8: "32px"
components:
  button-primary:
    backgroundColor: "{colors.intent-indigo}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    height: "32px"
  badge-accent:
    backgroundColor: "{colors.intent-indigo}"
    textColor: "{colors.intent-indigo}"
    rounded: "{rounded.full}"
  panel:
    backgroundColor: "{colors.surface-panel}"
    rounded: "{rounded.lg}"
  input-box:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    height: "32px"
---

# Design System: SFX Search

## Overview

**Creative North Star: "The Two-Room Studio"**

SFX Search has two faces, and the design serves both without splitting. The first room is the **library**: a dim, quiet space built for auditioning — rows of waveforms, instant playback, keyboard-first navigation, nothing competing with the sound. The second room is the **studio**: a workbench where a found sound gets shaped fast — trim, EQ, seamless looping, variation takes — dense controls that reward precision over ceremony.

The visual system is dyvoided.2, dark-first: a cool graphite neutral scale carries the UI while four seed-driven identity colors sit on top, each assigned to a **category of meaning**, never to decoration. Density is professional (presence 0.45): soft tactile gradients and inset rails, never loud. Everything numeric wears monospace with tabular figures.

**Key Characteristics:**
- Neutral graphite canvas; accents are semantic categories, not ornament
- `--primary` = user intent · `--accent-2` = live audio signal · `--accent-1` = processing · `--accent-3` = machine-proposed
- Custom canvas instruments (waveforms, scopes, meters) share the same token palette as the DOM
- Keyboard-first, dark-only by design, compact density available

## Colors

One neutral family plus four identity hues with assigned meaning; functional hues are fixed and semantic-only.

### Primary
- **Intent Indigo** (`--primary`, oklch(48% 0.17 275)): Everything the *user* decides or activates — primary buttons, selection (rows, tabs, chips, take cards), focus rings, active states, playback progress.

### Secondary
- **Signal Teal** (`--accent-2`, oklch(68% 0.10 190)): The live audio itself — waveform bodies (all channels, both in library and studio), spectrum-meter bars, the "is playing" row edge, pressed play button, live playhead cursor.
- **Proposal Magenta** (`--accent-3`, oklch(64% 0.17 345)): What the machine suggests — match regions and match scores in results, loop-candidate ranks/bands, loop-search progress fill, generated-variation context.

### Tertiary
- **Transform Amber** (`--accent-1`, oklch(72% 0.15 55)): Processing applied to the signal — fade/crossfade zones and envelopes, EQ response curve, pitch spline and pitch readouts, seam hairline.

### Neutral
- **Graphite scale** (`--gray-950` → `--gray-50`): app/panel/raised/sunken surfaces, borders, and all body text. Carries ~90% of every screen.
- **Signature Neutral** (`--signature-500`, fixed gray): exactly one decorative job — the panel top-edge line. Never a functional hue.
- **Success / Danger / Warning** (fixed): status and bounds only — loop IN (green) / OUT (red) markers, head/tail, hot signal bands, likes (danger), errors, banners.

### Named Rules
**The Category Rule.** An accent hue means exactly one category, app-wide. Teal never decorates; magenta never marks a user action. If a new element needs color, it joins a category or stays neutral.
**The Rarity Rule.** The graphite canvas owns the room; accents appear where they inform. A screen that is 10% colored is a screen with hierarchy.

## Typography

**Display Font:** Familjen Grotesk (page titles, large values; negative tracking)
**Body Font:** Hanken Grotesk (labels, buttons, paragraphs)
**Label/Mono Font:** JetBrains Mono ("DM Mono" inside canvas) — uppercase micro-labels, panel headers, and *every* number that measures something (`ds-tnum` tabular figures)

**Character:** Grotesk pair for a calm technical voice; mono reserved for measurement, not decoration.

### Hierarchy
- **Display** (Familjen 600, negative tracking): file titles, hero numbers
- **Title** (Hanken 500–600, `--text-sm`): rack labels, card titles, row filenames
- **Body** (Hanken 400, `--text-sm`/`--text-base`, 1.5): descriptions, buttons
- **Label** (JetBrains Mono 500, `2xs–xs`, +0.08em, UPPERCASE): panel titles, data keys, HUD pills, readouts, tick labels, scores

## Layout

Two shells: **library** (toolbar + hero search + folder pane / results list / inspector tri-pane, resizable via `.sfx-pane-divider`) and **studio** (topbar + module tabs + stage with canvas + HUD, transport bar, control rack of `.sfx-rack-card` columns). Spacing runs on the `--space-*` scale; rack rows are label-left / controls-right with `min-height: 28px`. Container queries (`main-list`, `inspector`) drive per-pane breakpoints; `[data-density="compact"]` tightens everything for power users.

## Elevation & Depth

Tonal layering driven by a single `--presence` knob (0.45 default): surfaces get gradient faces, `--inset-rail` recesses tracks/inputs, `--inset-highlight` adds a specular top edge, and layered `--shadow-sm/md/lg` float overlays. Panels carry the signature top-edge line. At presence 0 the system is near-flat; the tokens do the work either way — never write bespoke shadows.

## Shapes

Sharp **2px** corners on all controls and panels; **full pill** only for switches, badges, dots, avatars, scrollbar thumbs, and progress tracks. Canvas instruments stay rectangular; markers use hairline + flag geometry.

## Components

### Buttons
- **Shape:** 2px radius, `var(--control-height-md)` (32px); `ds-btn-sm` for dense racks
- **Primary:** Intent Indigo gradient (presence-driven), `--text-on-accent`
- **Secondary:** raised-surface gradient + `--border-strong`
- **Ghost / Danger:** transparent / fixed danger gradient
- **States:** 120ms transitions, `:active` translateY(1px), `:focus-visible` `--focus-ring`

### Sliders (DsRange)
- Real `ds-slider-track` (4px, `--control-track`, `--inset-rail`) + `ds-slider-fill` (primary ramp) + `ds-slider-knob` (14px gray-gradient disc, 2px primary border, muted-bg glow on drag/focus); native input overlaid transparent.

### Chips & Pills
- **Candidate/choice pills:** sunken bg + subtle border; active = `primary-muted-bg` + primary border. Candidate `.rank` = Proposal Magenta, `.score` = Success.
- **Badges:** `ds-badge-*` muted-bg + matching 400 text; pill radius.

### Cards / Containers
- `ds-panel`: panel gradient + signature top edge + `--shadow-md`
- `.sfx-var-take-card`: sunken, active = primary border, liked = danger border
- `.sfx-rack-card`: module columns inside the studio rack

### Inputs / Fields
- `ds-input-box` / `.sfx-num-input`: sunken gradient + subtle border; focus = primary border + `--focus-ring`; error = danger border
- `ds-check`/`ds-switch`: recessed track, primary when on

### Canvas Instruments
- `EditorWaveform`, `MiniWaveform`, `SeamScope`, `EqResponseGraph`, `SpectrumMeter`, `VariationWaveCardCanvas` — all read palette from the same tokens (`resolvePalette`/`readTokenColor`); canvas is rebrand-safe by convention.

## Do's and Don'ts

### Do:
- **Do** spend accents by category: teal for live audio, amber for processing, magenta for machine proposals, indigo for user intent.
- **Do** render controls with the kit's compound markup (`ds-slider-track/fill/knob`, `ds-select-*`, `ds-check`) rather than re-skinning native elements.
- **Do** keep numbers in mono with `ds-tnum`, and labels in uppercase mono micro-style.
- **Do** give every interactive element a `:focus-visible` `--focus-ring` and an accessible name.

### Don't:
- **Don't** color waveform channels differently — channels are position-differentiated (top/bottom), not hue.
- **Don't** hardcode hues or shadows — reference tokens; `--presence` owns tactility.
- **Don't** use `--signature` for anything functional; it is the panel top-edge, period.
- **Don't** put emoji or unicode glyphs in place of lucide icons; one icon per role, drawn at consistent size.
