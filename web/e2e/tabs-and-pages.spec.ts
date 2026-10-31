// Library and Studio tabs (T rules) and the Studio's edit / loop / variations
// pages (P rules). Spec: docs/testing/keyboard-contract.md
import type { Page } from "@playwright/test";
import {
  downloadButton,
  expect,
  keydownPrevented,
  libraryTab,
  openStudio,
  playingIndex,
  row,
  saveCalls,
  saveDialog,
  selectedIndex,
  studioPlayButton,
  studioShell,
  studioTab,
  test,
} from "./fixtures";

const trimStart = (page: Page) => studioShell(page).getByLabel("Trim Start (ms) value");
const undoToast = (page: Page) => page.locator(".sfx-undo-toast");
const takeCards = (page: Page) => page.locator(".sfx-var-take-card");
const studioFilename = (page: Page) => studioShell(page).locator(".sfx-studio-base .sfx-editor-filename");

/** Open the Studio for the selected row and make an edit (trim start 100 ms). */
async function openEdited(page: Page): Promise<void> {
  await openStudio(page);
  await trimStart(page).fill("100");
  await expect(studioTab(page).locator(".sfx-apptab-dot")).toBeVisible();
}

test.describe("tabs", () => {
  test("T1 Alt+2 / Alt+1 switch tabs and each tab keeps its state", async ({ app }) => {
    await app.keyboard.press("ArrowDown");
    await app.keyboard.press("ArrowDown");
    await openStudio(app);
    await expect(studioTab(app)).toHaveAttribute("aria-selected", "true");
    await app.keyboard.press("Digit3");
    await expect(studioShell(app)).toHaveAttribute("data-page", "loop");

    expect(await keydownPrevented(app, { key: "1", code: "Digit1", altKey: true })).toBe(true);
    await expect(libraryTab(app)).toHaveAttribute("aria-selected", "true");
    await expect(studioShell(app)).toHaveCount(0);
    expect(await selectedIndex(app)).toBe(2);

    await app.keyboard.press("Alt+2");
    await expect(studioShell(app)).toHaveAttribute("data-page", "loop");
    await expect(studioShell(app).getByRole("region", { name: "Loop" })).toBeVisible();
  });

  test("T2 the Studio tab without a file shows the empty state; Pick from Library goes back", async ({
    app,
  }) => {
    await studioTab(app).click();
    await expect(app.getByText("Open a file to start editing")).toBeVisible();
    await app.getByRole("button", { name: "Pick from Library" }).click();
    await expect(libraryTab(app)).toHaveAttribute("aria-selected", "true");
    await expect(row(app, 0)).toBeVisible();
  });

  test("T3 switching tabs stops playback in the tab you leave", async ({ app }) => {
    await app.keyboard.press("Space");
    await expect.poll(() => playingIndex(app)).toBe(0);
    await app.keyboard.press("Alt+2");
    await app.keyboard.press("Alt+1");
    expect(await playingIndex(app)).toBe(-1);

    await openStudio(app);
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
    await app.keyboard.press("Alt+1");
    await app.keyboard.press("Alt+2");
    await expect(studioPlayButton(app)).not.toHaveClass(/playing/);
  });

  test("T4 Edit in Studio replaces unedited work silently, and edited work with Undo", async ({
    app,
  }) => {
    await openStudio(app);
    await app.keyboard.press("Alt+1");
    await app.keyboard.press("ArrowDown");
    await openStudio(app);
    await expect(studioFilename(app)).toHaveText("snd1.wav");
    await expect(undoToast(app)).toHaveCount(0);

    await trimStart(app).fill("100");
    await app.keyboard.press("Alt+1");
    await app.keyboard.press("ArrowDown");
    await openStudio(app);
    await expect(studioFilename(app)).toHaveText("snd2.wav");
    await expect(undoToast(app)).toContainText("Studio now holds snd2.wav.");

    await undoToast(app).getByRole("button", { name: "Undo" }).click();
    await expect(undoToast(app)).toHaveCount(0);
    await expect(studioFilename(app)).toHaveText("snd1.wav");
    await expect(trimStart(app)).toHaveValue("100");
  });

  test("T5 Edit in Studio on the file already loaded keeps its edits", async ({ app }) => {
    await openEdited(app);
    await app.keyboard.press("Alt+1");
    await app.keyboard.press("e");
    await expect(studioShell(app)).toBeVisible();
    await expect(trimStart(app)).toHaveValue("100");
    await expect(undoToast(app)).toHaveCount(0);
  });

  test("T6 Alt+1 does nothing while a dialog is open, and the dialog covers the tabs", async ({
    app,
  }) => {
    await openStudio(app);
    await app.keyboard.press("Control+s");
    await expect(saveDialog(app)).toBeVisible();
    await app.keyboard.press("Alt+1");
    await expect(saveDialog(app)).toBeVisible();
    await expect(studioTab(app)).toHaveAttribute("aria-selected", "true");
    // The scrim lies over the app bar: a click there lands on the backdrop (which
    // closes the dialog), never on the Library tab.
    await libraryTab(app).click({ force: true });
    await expect(saveDialog(app)).toHaveCount(0);
    await expect(studioTab(app)).toHaveAttribute("aria-selected", "true");
  });

  test("T1 a mouse-clicked tab keeps no focus, so Space plays", async ({ app }) => {
    await openStudio(app);
    await libraryTab(app).click();
    await app.keyboard.press("Space");
    await expect.poll(() => playingIndex(app)).toBe(0);
    await studioTab(app).click();
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
  });

  test("T2 Ctrl+S on the empty Studio does not reach the browser", async ({ app }) => {
    await studioTab(app).click();
    expect(
      await keydownPrevented(app, { key: "s", code: "KeyS", ctrlKey: true })
    ).toBe(true);
  });

  test("T4 Undo after editing the newer file swaps back and keeps both", async ({ app }) => {
    await openEdited(app);
    await app.keyboard.press("Alt+1");
    await app.keyboard.press("ArrowDown");
    await openStudio(app);
    await trimStart(app).fill("200");
    await undoToast(app).getByRole("button", { name: "Undo" }).click();
    await expect(studioFilename(app)).toHaveText("snd0.wav");
    await expect(trimStart(app)).toHaveValue("100");
    // The clicked Undo keeps no focus: Space plays instead of undoing again.
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
    await expect(studioFilename(app)).toHaveText("snd0.wav");
    await app.keyboard.press("Space");
    // The newer file's work is held in turn, with its own Undo.
    await undoToast(app).getByRole("button", { name: "Undo" }).click();
    await expect(studioFilename(app)).toHaveText("snd1.wav");
    await expect(trimStart(app)).toHaveValue("200");
  });

  test("T4 replacing clean work keeps the earlier Undo alive", async ({ app }) => {
    await openEdited(app);
    await app.keyboard.press("Alt+1");
    await app.keyboard.press("ArrowDown");
    await openStudio(app);
    await app.keyboard.press("Alt+1");
    await app.keyboard.press("ArrowDown");
    await openStudio(app);
    await expect(studioFilename(app)).toHaveText("snd2.wav");
    await undoToast(app).getByRole("button", { name: "Undo" }).click();
    await expect(studioFilename(app)).toHaveText("snd0.wav");
    await expect(trimStart(app)).toHaveValue("100");
  });
});

test.describe("Studio pages", () => {
  test("P1 the loop page saves the loop, tagged as a loop, under .loop", async ({ app, api }) => {
    await openStudio(app);
    await app.keyboard.press("Digit3");
    await app.getByRole("button", { name: "Save to Library" }).click();
    await expect(saveDialog(app).getByLabel("Filename")).toHaveValue("snd0.loop.wav");
    await expect(saveDialog(app)).toContainText("crossfade baked in");
    await saveDialog(app).getByRole("button", { name: "Save", exact: true }).click();
    await expect(saveDialog(app)).toHaveCount(0);
    const calls = saveCalls(api);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("loop=true");
    expect(calls[0]).toContain("folder=%2Flib%2Fa");
    expect(calls[0]).toContain("source_file_id=f0");
  });

  test("S1 after a mouse click on a Studio button, Space plays", async ({ app }) => {
    await openStudio(app);
    await app.getByRole("button", { name: "Reverse Audio" }).click();
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
    await expect(app.getByRole("button", { name: "Reverse Audio" })).toHaveClass(/active/);
  });

  test("P2 the edit page saves the edit, not tagged as a loop", async ({ app, api }) => {
    await openEdited(app);
    await app.getByRole("button", { name: "Save to Library" }).click();
    await expect(saveDialog(app).getByLabel("Filename")).toHaveValue("snd0.edit.wav");
    await expect(saveDialog(app)).toContainText("Trim");
    await saveDialog(app).getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => saveCalls(api).length).toBe(1);
    expect(saveCalls(api)[0]).toContain("loop=false");
  });

  test("P3 S13 Generate (G) makes selected takes; Download counts the selected ones", async ({
    app,
    api,
  }) => {
    await openStudio(app);
    await app.keyboard.press("Digit4");
    await app.keyboard.press("g");
    await expect(takeCards(app)).toHaveCount(6);
    await expect(downloadButton(app)).toHaveCount(0);
    await expect(app.getByRole("button", { name: "Download 6 files" })).toBeEnabled();
    await app.getByRole("checkbox", { name: "Include take 2" }).click();
    await expect(app.getByRole("button", { name: "Download 5 files" })).toBeEnabled();

    await app.getByRole("button", { name: "Save to Library" }).click();
    const dlg = app.getByRole("dialog", { name: "Save takes to library" });
    await expect(dlg.getByRole("list", { name: "Files" }).getByRole("listitem")).toHaveCount(5);
    await dlg.getByRole("button", { name: "Save 5 files" }).click();
    await expect(dlg).toHaveCount(0);
    expect(saveCalls(api)).toHaveLength(5);
    expect(saveCalls(api).every((c) => c.includes("loop=false"))).toBe(true);
  });

  test("P4 changing the edit after generating marks the takes stale", async ({ app }) => {
    await openStudio(app);
    await app.keyboard.press("Digit4");
    await app.keyboard.press("g");
    await expect(takeCards(app)).toHaveCount(6);
    await app.keyboard.press("Digit1");
    await trimStart(app).fill("100");
    await app.keyboard.press("Escape"); // leave the number field (S10)
    await app.keyboard.press("Digit4");
    await expect(app.getByText("The edit changed after these takes were made.")).toBeVisible();
    await app.getByRole("button", { name: "Regenerate" }).click();
    await expect(app.getByText("The edit changed after these takes were made.")).toHaveCount(0);
  });

  test("P5 Replace source with loop makes the loop the edited file, with Undo", async ({ app }) => {
    await openStudio(app);
    await app.keyboard.press("Digit3");
    await app.getByRole("button", { name: "Replace source with loop" }).click();
    await expect(studioShell(app)).toHaveAttribute("data-page", "edit");
    await expect(studioFilename(app)).toHaveText("snd0.loop.wav");
    // A derived file is unsaved work from the start.
    await expect(studioTab(app).locator(".sfx-apptab-dot")).toBeVisible();
    // The source had no edits, so nothing was held for Undo.
    await expect(undoToast(app)).toHaveCount(0);

    // Replacing the derived (unsaved) file offers Undo, and Undo brings back its page.
    await app.keyboard.press("Digit4");
    await app.keyboard.press("g");
    await takeCards(app).nth(2).getByRole("button", { name: "Replace source" }).click();
    await expect(studioFilename(app)).toHaveText("snd0.loop_var_03.wav");
    await expect(undoToast(app)).toContainText(
      "snd0.loop.wav and its edits were replaced."
    );
    await undoToast(app).getByRole("button", { name: "Undo" }).click();
    await expect(studioShell(app)).toHaveAttribute("data-page", "variations");
    await expect(takeCards(app)).toHaveCount(6);
  });

  test("P6 Loop opens over the edit page; a click on the edit page around it goes back", async ({
    app,
  }) => {
    await openEdited(app);
    await app.getByRole("button", { name: "Create loop" }).click();
    const sheet = studioShell(app).getByRole("region", { name: "Loop" });
    await expect(sheet).toBeVisible();

    // The edit page stays in view but out of reach: Tab never lands on it.
    const base = studioShell(app).locator(".sfx-studio-base");
    await expect(base).toHaveAttribute("inert", "");
    await expect(base).toHaveAttribute("aria-hidden", "true");
    for (let i = 0; i < 12; i++) {
      await app.keyboard.press("Tab");
      const onBase = await app.evaluate(() =>
        Boolean(document.activeElement?.closest(".sfx-studio-base"))
      );
      expect(onBase).toBe(false);
    }

    // A click on the dimmed edit page beside the sheet goes back; the edit is kept.
    await app.locator(".sfx-studio-sheet-scrim").click({ position: { x: 8, y: 300 } });
    await expect(sheet).toHaveCount(0);
    await expect(studioShell(app)).toHaveAttribute("data-page", "edit");
    await expect(base).not.toHaveAttribute("inert");
    await expect(trimStart(app)).toHaveValue("100");
  });
});
