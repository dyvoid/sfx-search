# Review Decisions Log

Findings that were reviewed and deliberately **not** fixed, or behavior that was confirmed as
intended. Reviewers (human or AI) should read this before reporting, and should not re-report
an item here unless they have new evidence that changes the reasoning. Add an entry whenever a
finding is rejected or an intended behavior is confirmed.

Format: what, decision, why. Newest last within each section.

## Intended behavior

- **Saving does not switch the Studio to the saved file** (supersedes the earlier "Studio switches
  to the saved file"). The Studio keeps its work; turning output into the edited file is the
  explicit "Replace source" ([ADR 0007](adr/0007-library-studio-tabs-and-studio-pages.md)).
- **Overwrite with a custom name replaces whatever file has that name** in the source folder, not
  just the source. That is what "Replace file if it already exists" means.
- **Deleting every file in a root does not mark them missing.** Trade-off of the offline-root
  guard: an existing-but-empty root that still has indexed files is treated as offline
  (unmounted drive). Remove the root from the library to drop its files.
- **An unreadable subtree is protected from "missing"**, not its whole root (a drive root always
  errors on e.g. `System Volume Information`).
- **Escape on a focused `<button>` on the Loop or Variations page goes back to the edit page.**
  Only sliders/checkboxes blur first.
- **Changing tokenization requires a reindex.** Existing `search_text` is not migrated.

## Rejected or deferred findings

- **Theoretical races in `save-edited`** (two concurrent saves picking the same free name).
  Rejected: single-user local tool; the realistic trigger (double submit) is fixed client-side.
- **Error messages include temp paths / ffmpeg stderr.** Rejected: local tool, no exposure.
- **`name=foo.wav.` produces `foo.wav.wav`.** Rejected: cosmetic; the UI strips `.wav`.
- **Custom names are sanitized silently** (stripped characters not shown before saving).
  Rejected: the real filename is shown in the status line after saving.
- **Linux `NAME_MAX` (255 bytes) with long multi-byte names.** Rejected: the target platform is
  Windows (UTF-16 limits); stems are already capped at 120 characters.
- **`compute_file_id` lowercases paths, so `Take.wav` and `take.wav` collide on Linux.**
  Rejected: matches Windows case-insensitive semantics, which is the target.
- **Stale index after a valid overwrite whose re-index fails.** Accepted: a rescan fixes it; the
  file itself is valid.
- **Leftover peaks JSON when indexing fails for a new file.** Rejected: harmless.
- **`sf.info` header parse runs on the event loop.** Rejected: header-only read, cheap.
- **Overwriting an existing file that has no user data copies the source's user data onto it.**
  Accepted as reasonable; not clearly wrong.
- **Stray punctuation left in the semantic query after `dur:` stripping** (e.g. `rain ( )`).
  Rejected: cosmetic, no effect on ranking worth the code.
- **Waveform palette is resolved once and doesn't follow a theme switch.** Deferred: dark theme
  is the default; pre-existing.
- **After Enter in the search box, Up/Down don't navigate until Escape or `/`.** Deferred:
  pre-existing, possibly intended (keeps typing context).
- **MCP `batch_search` over-limit error text is hidden by FastMCP** ("Error executing tool
  batch_search"). Accepted: the call still fails loudly instead of truncating silently.
- **The manual "enter a path" field has no placeholder.** Rejected (user decision): a hint
  inside that field confused more than it helped; it has an accessible name ("Folder path"),
  autofocuses, and sits next to Add/Cancel right after "or enter a path" was clicked.
- **Compact density keeps the kit's smaller controls (22–26px).** Intended: compact is an
  explicit opt-in for power users; the 28px floor in DESIGN.md applies to the default density.
- **Folder-tree chevrons and checkboxes are 15px.** Accepted: the whole tree row is clickable
  and the tree is a dense secondary navigator.
- **The library footer is a full-width bar.** Superseded the earlier "footer inside the
  results panel" decision: bars frame every screen (DESIGN.md Readability Rule 1).
- **Footer key hints are hidden below 960px.** Intended: the status message takes the room.
- **No visible cue on the Studio rack when it scrolls internally** (short windows). Deferred:
  the scrollbar and cut-off card edge show it; revisit if users miss controls.
- **The first-run scan-error screen has no Add folder control.** Intended: the fix is "Try
  again"; the header's Folders button covers changing folders.
- **"Play from best match" switch and "or enter a path" link are under 28px.** Accepted: text
  toggles in a bar, with label-sized hit areas; both are keyboard reachable (L18, L20).
- **The waveform readout strip stays in modules without markers (Tone & EQ, Variations).**
  Intended: hiding it would make the waveform jump in height when switching modules.
- **The "unsaved work" guard counts edits, not saves.** The amber dot, the Undo toast and the
  prompt on closing the page fire while the Studio holds edits, a loop, takes or a derived file,
  even right after saving them. Accepted: simple and on the safe side.
- **No "Saves as" filename in the Loop and Variations headers** (the wireframe had one). The
  output dialog shows the editable filename; the header stays uncluttered.
- **No 1–6 keys to audition takes** (proposed in the wireframe). They would clash with 1–4, which
  switch modules and pages from every Studio page.
- **The take cards draw the take with its pitch and volume curves, not over a faint outline of the
  source** (wireframe). Deferred: takes differ in length, so a shared time scale needs more work
  than it is worth now.
- **Download of several takes is one browser download per file**, not a ZIP. Browsers ask once per
  site to allow multiple downloads. Revisit if it gets in the way.
- **No hint when Save or Download is disabled** (no takes selected, no folder chosen). Rejected
  (user preference: no clutter): the button state, the "0 of 6 selected" count and the "Choose a
  folder" placeholder already say why.
- **The "edit changed" notice stays after the edit is changed back.** Accepted: conservative; the
  takes were made from a different edit object, and Regenerate is one click.
- **A second open before the first session reports its status gets no Undo.** Rejected: not
  reachable by hand (status lands in the same frame).
- **Hidden sessions keep their decoded audio and transport while Undo is offered.** Accepted:
  bounded to one extra session for ~8 s; their playhead loop is stopped.
