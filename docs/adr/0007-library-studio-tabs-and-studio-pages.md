# ADR 0007: Library and Studio Tabs, and Studio Pages per Output

- **Status:** Accepted
- **Date:** 2026-10-31
- **Amends:** [ADR 0004](0004-integrated-audio-editor-and-loop-module.md) (Edit Mode as a screen
  reached from the library; four equal modules)

## Context

The Studio was a screen that replaced the library, reached only from a selected result, and it
loaded whatever the library had selected. Its four modules were equal tabs: Trim & Gain and Tone &
EQ shape the sound, while Seamless Loop and Variations make something new from it. Enable switches
("Export as loop", Trim & Gain on/off) decided what Save and Download produced, so the output was
hidden state: users could not tell whether the loop was "on".

A wireframe set (`redesign/`, not part of the app) proposed the structure decided here.

## Decision

1. **Two top-level tabs, both kept mounted.** An app bar holds the Library and Studio tabs
   (Alt+1 / Alt+2). Each keeps its own state while the other is in front. Only the tab in front may
   play; switching stops playback. The Studio no longer follows the library's selection.
2. **A Studio session per source.** `App` owns sessions (`{ id, source }`); a `StudioView` is keyed
   by session, so loading another file is a new session. A source is a library hit, a local file,
   or rendered audio (`DerivedSource`). When the current session holds unsaved work, the replaced
   session stays mounted but hidden for ~8 s and an Undo toast can swap it back: Undo restores every
   edit, setting, take and page with no serialization. No navigation stack beyond that one step.
3. **Pages instead of four modules.** The edit page (Trim & Gain, Tone & EQ) is the base and has no
   enable switches: edits apply live, each module has a Reset. Loop and Variations are separate
   pages whose input is the edited sound. Save to Library and Download sit in the same place on
   every page and act on that page's output: the edit, the loop (crossfade baked in, `.loop`), or
   the selected takes. The page you are on is the output; there is no "export as loop" state.
4. **Replace source.** A loop or a take can become the Studio's file. It is destructive by design
   and goes through the same replace-with-Undo path as Edit in Studio.
5. **Save into a chosen library folder.** `POST /api/library/save` writes into any folder inside a
   library root, with or without a library source (whose favorite, tags and note it can inherit),
   so local files can be saved to the library too. Only loops get the `loop` tag.

## Consequences

- The Library and the Studio can be used side by side without losing work; the cost is keeping
  both trees (and up to two Studio sessions' decoded audio) in memory, which is small at sound-effect
  lengths.
- Every window-level key handler must check that its tab (or session) is the one in front.
- Leaving the Studio no longer has a key: Escape now steps back from Loop or Variations to the edit
  page. The keyboard contract records the new rules (T1–T6, S2, S5, S12, S13, P1–P5).
- Saving no longer switches the Studio to the saved file; the Library adds it to its results
  without moving its own selection.
- `StudioView` shrank by moving the panels (`editor/panels/`) and the output dialog
  (`editor/OutputDialog.tsx`) into their own components; it still owns the session's state.
