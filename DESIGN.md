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

The visual system is dyvoided.2, dark-first: a cool graphite neutral scale carries the UI while four seed-driven identity colors sit on top, each assigned to a **category of meaning**, never to decoration. Density is professional (presence 0.45): soft tactile gradients and inset rails, never loud. Everything numeric wears monospace with tabular figures; words are set in the body font.

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
**Mono Font:** JetBrains Mono ("DM Mono" inside canvas) — *every* number that measures something (`ds-tnum` tabular figures), paths, and key caps. Never for words.

**Character:** Grotesk pair for a calm technical voice; mono reserved for measurement, not decoration.

### Hierarchy
- **Display** (Familjen 600, negative tracking): file titles, hero numbers
- **Section title** (kit `ds-panel-title`: mono 500, `--text-xs`, uppercase, wide tracking, `--text-secondary`): panel and card titles. Filenames are Hanken 600.
- **Label** (Hanken 400–500, `--font-size-sm`, `--text-secondary`): control labels, rack row labels, filter labels (`ds-microlabel`)
- **Key** (Hanken 400, `--font-size-xs`, `--text-tertiary`): data keys above or beside a value (`sfx-param-label`, `sfx-kv-key`)
- **Body** (Hanken 400, `--font-size-sm`/`--font-size-base`, 1.5): descriptions, buttons
- **Value** (JetBrains Mono, `xs–sm`, tabular): readouts, durations, levels, scores, tick labels, paths

## Layout

Two shells: **library** (toolbar + hero search + folder pane / results list / inspector tri-pane, resizable via `.sfx-pane-divider`) and **studio** (topbar + module tabs + stage with canvas + HUD, transport bar, control rack of `.sfx-rack-card` columns). Spacing runs on the `--space-*` scale; rack rows are label-left / controls-right with `min-height: 32px`. Container queries (`main-list`, `inspector`) drive per-pane breakpoints; `[data-density="compact"]` tightens everything for power users.

## Elevation & Depth

Three layers, always distinguishable: the **background** (`--surface-app`) shows in the gutters; **bars** (`--surface-panel`, full width, hairline-separated) frame the page; **panels** (`--surface-panel`, subtle border, `--radius-md`) hold content and sit on the background with a gutter around them; **controls** sit inside panels (sunken inputs, raised buttons). A panel never sits on a panel of the same tone.


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

## Readability Rules

Learned from comparing the Studio against a redesign mock: the mock read better at every size
because of space and layering, not fonts. These apply to every screen.

1. **Bars frame the page, panels hold the content.** Bars (top bar, search/tool row, the
   waveform's readout strip, transport, footer) span the full width on `--surface-panel`
   with hairlines between them, one job per bar, so the page reads top to bottom. Content
   regions (results, folder tree, inspector, waveform, each Studio rack card) are panels on
   the background with a gutter. Dialogs follow the same order: header bar, body, action bar.
2. **Words in the body font, values in mono.** Labels, buttons, hints and HUD buttons use
   Hanken Grotesk as written. Section titles (`ds-panel-title`) are the one exception: the
   kit's uppercase mono marks the section level. Mono is otherwise for numbers, times,
   levels, paths and key caps.
3. **Readable floor.** No text below 12px; control labels 13px; section titles 12px uppercase mono.
   Controls in panels are at least 28px high (a small icon button laid over a canvas may be
   24px); rows at least 32px apart.
4. **Controls get the space they need.** In the Studio the rack takes its natural height and
   the waveform takes what is left (with a sensible minimum), not the other way around. On a
   short window the rack scrolls inside itself; the footer never leaves the screen.
5. **Key hints are keys.** Shortcuts render as a key cap plus a plain word
   (`[Space] Preview`), never as one run-on mono string.
6. **Group by job.** A toolbar splits into "work on this sound" (left) and "save / export"
   (right); a panel header holds its title and at most one or two actions that never wrap.

## UX Rules

Hard rules for every screen and state. They come from real review failures; check each new or
changed screen against them in every state it can be in (first run, indexing, results, empty,
error, each Studio module, each dialog).

1. **Only what works now.** Show a control, hint or keyboard shortcut only when it can do
   something in the current state. No disabled-but-visible chrome "for later": on first run
   there is no search bar, transport or key-hint footer, just the setup.
2. **No fake values.** No example data in fields or placeholders (`D:/SFX`, sample names). An
   empty field is empty; the label says what goes in it.
3. **No insider vocabulary.** Users never see implementation names: RRF, BM25, CLAP, chunk,
   embedding, rule IDs. Describe what the user gets, not how it is computed.
4. **Name the capability, not an example of it.** A free-text path field is "enter a path",
   not "paste a path". Labels must not narrow what a control accepts.
5. **One obvious main action per screen or panel.** The common path is primary; alternatives
   are visibly secondary (quiet link, ghost button), never the other way around.
6. **Every element earns its place.** No headers, captions or frames that restate the
   obvious (a table header "Folder path / Action" over a list of folders with a Remove button).
7. **Data keeps its shape.** Paths, filenames and user text are shown as-is: never uppercased,
   truncated mid-word without a tooltip, or restyled into micro-labels.
8. **Context follows the mode.** Module-specific controls appear only in their module (Test
   Seam only in Seamless Loop); status-bar hints match the active screen.

## Do's and Don'ts

### Do:
- **Do** spend accents by category: teal for live audio, amber for processing, magenta for machine proposals, indigo for user intent.
- **Do** render controls with the kit's compound markup (`ds-slider-track/fill/knob`, `ds-select-*`, `ds-check`) rather than re-skinning native elements.
- **Do** keep numbers in mono with `ds-tnum`, and words (titles, labels, hints) in the body font as written.
- **Do** give every interactive element a `:focus-visible` `--focus-ring` and an accessible name.

### Don't:
- **Don't** color waveform channels differently — channels are position-differentiated (top/bottom), not hue.
- **Don't** hardcode hues or shadows — reference tokens; `--presence` owns tactility.
- **Don't** use `--signature` for anything functional; it is the panel top-edge, period.
- **Don't** put emoji or unicode glyphs in place of lucide icons; one icon per role, drawn at consistent size.
