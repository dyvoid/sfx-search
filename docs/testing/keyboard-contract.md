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
  except Ctrl/Cmd+S in the Studio.
- **Held keys don't repeat actions.** Auto-repeat is ignored for one-shot actions (play, save,
  favorite, toggles); only continuous actions (marker nudge, list navigation) repeat.
- **One audio stream** plays at a time.

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
| L8 | results shown | E | Open the Studio on the selected row; library audio pauses. |
| L9 | a row button (Play/Edit/Reveal/Similar/Favorite) was mouse-clicked | Space / Enter / arrows | Act on the library selection (focus was released by the click). |
| L10 | a row button is focused by Tab | Space / Enter | Activate that button only. |
| L11 | dropdown option picked by mouse, then a row's waveform clicked | Space | Play/pause; the dropdown does not reopen. |
| L12 | a dropdown (DsSelect) is open | ArrowUp/Down, Home, End | Move between options; the results selection does not move. |
| L13 | a dropdown is open | Escape | Close only the dropdown (inspector stays open); focus returns to its trigger. |
| L14 | a dropdown is open | Enter / Space on an option | Select it, close, focus the trigger. Tab closes it. |
| L15 | Library (folders) modal open | Tab / Shift+Tab | Focus stays inside the modal and wraps; disabled controls are skipped. |
| L16 | Library modal open | Escape | Close the modal; focus returns to the button that opened it. Library shortcuts are inert while open. |
| L17 | Remove root / Rebuild all | click | First click arms ("Confirm …") for ~3 s; only a second click acts. Remove is disabled while a scan runs. |
| L18 | Best offset switch, Favorites only checkbox | Tab, then Space / Enter | Reachable by Tab and toggled by keyboard; exposes role and checked state. |
| L19 | transient footer error (e.g. reveal failed) | — | Clears after ~5 s. The "Similar to …" label is not transient. |

## Studio

| ID | Context | Key | Expected |
|---|---|---|---|
| S1 | Studio, nothing focused | Space | Play/pause. |
| S2 | Studio | Digit1–4 | Switch module (Trim & Gain, Tone & EQ, Seamless Loop, Variations). |
| S3 | Studio | `[` / `]` | Select the start / end marker (crop handle in Trim & Gain). |
| S4 | Studio | ArrowLeft / ArrowRight | Nudge the active marker 1 ms; Shift = 10 ms; auto-repeat keeps nudging. |
| S5 | Studio | Ctrl/Cmd+S | With a library file: open the save dialog. Without one (local file): download. Never the browser's Save Page dialog, including while audio is still decoding and on auto-repeat. Ctrl+Shift+S and Ctrl+Alt+S are not the save chord. Matched on the typed key, not the physical key. |
| S6 | Studio | S / F / Home | Audition the loop seam (Seamless Loop only; elsewhere S is not handled and the Test Seam button is hidden) / run loop search / restart the loop. |
| S7 | slider (range input) focused | ArrowLeft/Right/Up/Down, Home, End, PageUp/Down | Move the slider natively; no marker nudge. |
| S8 | slider focused | Space, Digit1–4, Ctrl/Cmd+S | Studio shortcuts still work. |
| S9 | checkbox / radio focused | Space / Enter | Toggle natively, once per press. |
| S10 | text or number input focused | digits / letters | Typed into the input; no module switch or shortcut. Ctrl/Cmd+S still opens save. |
| S11 | Studio | Ctrl/Cmd/Alt + other keys (e.g. Ctrl+1, Cmd+ArrowLeft) | Not handled; not preventDefault'd. |
| S12 | Studio | Escape | Leave the Studio (back to the library). Escape on a focused slider/checkbox blurs it first. |

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
| D10 | loaded file changes while open | — | Dialog closes. |
