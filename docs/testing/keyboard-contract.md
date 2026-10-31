# Keyboard Contract

The expected keyboard behavior of the web app, as a checklist. Each rule has an ID; the
Playwright specs in `web/e2e/` reference these IDs in their test titles, so a failing test
names the rule it broke. Change a rule here first, then the code and its test.

Global principles:

- **Typing is never hijacked.** Keys typed into a text field (input, textarea, select,
  contentEditable) are never treated as shortcuts, except the documented exceptions below.
- **Focused controls act natively.** Space/Enter on a focused button, switch, checkbox or option
  activates that control, and only that control (no app shortcut fires as well).
- **Mouse clicks don't leave stray focus.** After a mouse click in a result row, Space/Enter act
  on the library, not on whatever button or dropdown had focus before.
- **Browser chords stay the browser's.** Ctrl/Cmd/Alt combinations pass through untouched,
  except Alt+1 / Alt+2 (switch tabs) and Ctrl/Cmd+S in the Studio.
- **Held keys don't repeat actions.** Auto-repeat is ignored for one-shot actions (play, save,
  favorite, toggles); only continuous actions (marker nudge, list navigation) repeat.
- **One audio stream** plays at a time. Only the tab in front plays; switching tabs stops
  playback, and each tab keeps its own position.

## Library view

| ID | Context | Key | Expected |
|---|---|---|---|
| L1 | results shown | ArrowDown / ArrowUp | Move selection one row (clamped), scroll it into view. Past the loaded rows, more load. |
| L2 | results shown | Space | Play/pause the selected row at its best-chunk offset. Starting another row stops the first. |
| L3 | results shown | Enter | Toggle the inspector panel. |
| L4 | results shown | F | Toggle favorite on the selected row. |
| L5 | results shown | R | Reveal the selected file. On failure the footer shows an error. |
| L6 | anywhere outside a text field | `/` | Focus the search box. |
| L7 | search box focused | Escape | Blur the search box; library shortcuts work again. |
| L8 | results shown | E | Load the selected row into the Studio and switch to the Studio tab; library audio stops. See T4/T5 for what happens to work already in the Studio. |
| L9 | a row button (Play/Edit/Reveal/Similar/Favorite) was mouse-clicked | Space / Enter / arrows | Act on the library selection (focus was released by the click). |
| L10 | a row button is focused by Tab | Space / Enter | Activate that button only. |
| L11 | dropdown option picked by mouse, then a row's waveform clicked | Space | Play/pause; the dropdown does not reopen. |
| L12 | a dropdown (DsSelect) is open | ArrowUp/Down, Home, End | Move between options; the results selection does not move. |
| L13 | a dropdown is open | Escape | Close only the dropdown (inspector stays open); focus returns to its trigger. |
| L14 | a dropdown is open | Enter / Space on an option | Select it, close, focus the trigger. Tab closes it. |
| L15 | Library (folders) modal open | Tab / Shift+Tab | Focus stays inside the modal and wraps; disabled controls are skipped. |
| L16 | Library modal open | Escape | Close the modal; focus returns to the button that opened it. Library shortcuts are inert while open. |
| L17 | Remove root / Rebuild all | click | First click arms ("Confirm …") for ~3 s; only a second click acts. Remove is disabled while a scan runs. |
| L18 | Play from best match switch, Favorites only checkbox | Tab, then Space / Enter | Reachable by Tab and toggled by keyboard; exposes role and checked state. |
| L19 | transient footer error (e.g. reveal failed) | — | Clears after ~5 s. The "Similar to …" chip in the search bar is not transient and has an "Exit similarity view" button. |
| L20 | Library modal / first-run screen | click / Enter | "Add folder…" opens the native picker and adds the pick. "or enter a path" reveals an empty, focused path field (no placeholder); Enter adds and hides it; Cancel hides it and returns focus to "or enter a path". |

## Tabs

| ID | Context | Key | Expected |
|---|---|---|---|
| T1 | anywhere, no dialog open | Alt+1 / Alt+2, or a click on a tab | Switch to the Library / Studio tab. Each tab keeps its state: Library query, filters, folders, scroll and selection; Studio file, edits, loop and variations settings, takes and page. |
| T2 | Studio tab, no file loaded | — | Empty state with Open file, Pick from Library (switches to the Library) and drag-and-drop. Ctrl/Cmd+S is blocked (no browser Save Page). |
| T3 | something is playing | switch tabs | Playback stops; coming back leaves the tab stopped at its position. |
| T4 | Edit in Studio / Open file / drop, Studio holds unsaved work | — | The new file replaces it at once; a toast "Studio now holds …" offers Undo for ~8 s, which restores the previous file with every edit, setting, take and its page. Work done meanwhile in the newer file is not dropped: Undo swaps, and the newer file is held with its own Undo. No toast when the Studio was empty or unedited; replacing unedited work keeps an Undo that is already offered. |
| T5 | Edit in Studio on the library file already loaded | E | Switch to the Studio; its edits are kept. |
| T6 | a dialog is open (Studio output dialog, Library modal) | Alt+1 / Alt+2, click on a tab | Nothing: the dialog keeps the keyboard, and its scrim covers the tab bar (a click there is a backdrop click). |

## Studio

The Studio has an edit page (modules Trim & Gain and Tone & EQ) and two pages made from its
output: Loop and Variations.

| ID | Context | Key | Expected |
|---|---|---|---|
| S1 | Studio, nothing focused | Space | Play/pause. After playing through to the end, the next play starts from the top. A mouse-clicked Studio button (outside dialogs) or app tab keeps no focus, so Space plays after it. |
| S2 | Studio | Digit1–4 | 1 / 2: Trim & Gain / Tone & EQ on the edit page (from Loop or Variations: back to the edit page first). 3 / 4: open the Loop / Variations page. Changing page stops playback. |
| S3 | Studio, Trim & Gain or Loop page | `[` / `]` | Select the start / end marker (crop handle in Trim & Gain). Not handled elsewhere. |
| S4 | Studio, Trim & Gain or Loop page | ArrowLeft / ArrowRight | Nudge the active marker 1 ms; Shift = 10 ms; auto-repeat keeps nudging. Not handled in other modules. |
| S5 | Studio | Ctrl/Cmd+S | Open Save to Library for the current page's output (the source's folder preselected; none for a local file). With no library folders configured: open the Download dialog instead. Never the browser's Save Page dialog, including while audio is still decoding and on auto-repeat. Ctrl+Shift+S and Ctrl+Alt+S are not the save chord. Matched on the typed key, not the physical key. |
| S6 | Studio | S / F / Home | Audition the loop seam / run loop search (both Loop page only; elsewhere not handled, and the Test Seam button is hidden) / restart playback. |
| S7 | slider (range input) focused | ArrowLeft/Right/Up/Down, Home, End, PageUp/Down | Move the slider natively; no marker nudge. |
| S8 | slider focused | Space, Digit1–4, Ctrl/Cmd+S | Studio shortcuts still work. |
| S9 | checkbox / radio focused | Space / Enter | Toggle natively, once per press. |
| S10 | text or number input focused | digits / letters | Typed into the input; no module switch or shortcut. Ctrl/Cmd+S still opens save. |
| S11 | Studio | Ctrl/Cmd/Alt + other keys (e.g. Ctrl+1, Cmd+ArrowLeft) | Not handled; not preventDefault'd. |
| S12 | Studio | Escape | Loop or Variations page: back to the edit page, settings kept. Edit page: nothing (not prevented). Escape on a focused slider/checkbox blurs it first. |
| S13 | Studio, Variations page | G | Generate the takes. Not handled on other pages. |

## Studio save dialog

| ID | Context | Key | Expected |
|---|---|---|---|
| D1 | dialog opens | — | Focus lands in the filename field; any old error is cleared. |
| D2 | dialog open | Tab / Shift+Tab | Focus stays inside the dialog and wraps, including from outside it. |
| D3 | dialog open | Escape | Close the dialog only (stay in the Studio); focus returns to the opener. |
| D4 | filename field | Enter | Save once. A second Enter during the save does nothing. |
| D5 | Save to Library button | hold Enter | Opens the dialog; the auto-repeat must **not** also save. |
| D6 | filename field | hold Backspace / letters | Edits repeat normally. |
| D7 | dialog open | Ctrl/Cmd+S (any focus inside) | Blocked (no browser dialog), no second dialog or save. |
| D8 | "Replace file" checkbox | hold Space / Enter | Toggles once per press. |
| D9 | save fails | — | Error shown inside the dialog (role=alert); dialog stays open for retry. |
| D10 | the Studio's file is replaced while open (e.g. a file is opened) | — | Dialog closes; it is not open when Undo brings the old file back. |

## Studio pages and output

Behavior rules for the pages; the e2e tests reference these IDs too.

| ID | Context | Action | Expected |
|---|---|---|---|
| P1 | Loop page | Save to Library / Download | Outputs the loop with the crossfade baked in, named `<name>.loop`, tagged `loop`. |
| P2 | edit page | Save to Library / Download | Outputs the edited sound, named `<name>.edit`, never tagged `loop`; no loop and no takes. |
| P3 | Variations page | Generate, take checkboxes | Every new take starts selected. Save and Download act on the selected takes, one file each; the buttons count them ("Download 5 files"). |
| P4 | Variations page, takes exist | the edit changes | "The edit changed after these takes were made." with Regenerate. Loop markers reset to the whole sound whenever the trim or direction changes. |
| P5 | Loop page / a take | Replace source | That output becomes the Studio's file (unsaved, amber dot), on the edit page, as in T4: Undo while the toast shows. |
| P6 | Loop or Variations page | Tab; a click on the dimmed edit page around the sheet | Loop and Variations open as a sheet over the edit page, which stays in view but inert: Tab never lands on it. A click on it goes back to the edit page (as Escape, S12), settings kept. |
