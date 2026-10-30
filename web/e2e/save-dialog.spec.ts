// Studio save-dialog keyboard contract, rules D1-D10.
// Spec: docs/testing/keyboard-contract.md
import type { Page } from "@playwright/test";
import {
  expect,
  flushApi,
  focusedName,
  holdKey,
  keydownPrevented,
  makeWav,
  openStudio,
  saveCalls,
  saveDialog,
  studioShell,
  test,
} from "./fixtures";

const saveButton = (page: Page) => page.getByRole("button", { name: "Save to Library" });
const filename = (page: Page) => saveDialog(page).getByLabel("Filename");
const replaceBox = (page: Page) => saveDialog(page).getByRole("checkbox");
const dialogAlert = (page: Page) => saveDialog(page).getByRole("alert");

async function openDialog(page: Page): Promise<void> {
  await openStudio(page);
  await saveButton(page).click();
  await expect(saveDialog(page)).toBeVisible();
}

test("D1 focus lands in the filename field when the dialog opens", async ({ app }) => {
  await openDialog(app);
  await expect(filename(app)).toBeFocused();
  await expect(filename(app)).toHaveValue(/^snd0.*\.wav$/);
});

test.describe("save fails", () => {
  test.use({ apiOptions: { saveStatus: 500, saveErrorDetail: "Disk full" } });

  test("D1 an old error is cleared when the dialog reopens", async ({ app }) => {
    await openDialog(app);
    await app.keyboard.press("Enter");
    await expect(dialogAlert(app)).toContainText("Disk full");
    await app.keyboard.press("Escape");
    await expect(saveDialog(app)).toHaveCount(0);

    await saveButton(app).click();
    await expect(saveDialog(app)).toBeVisible();
    await expect(dialogAlert(app)).toHaveCount(0);
    await expect(filename(app)).toBeFocused();
  });

  test("D9 a failed save shows a role=alert error inside the dialog, which stays open for retry", async ({
    app,
    api,
  }) => {
    await openDialog(app);
    await app.keyboard.press("Enter");
    await expect(dialogAlert(app)).toContainText("Disk full");
    await expect(saveDialog(app)).toBeVisible();
    expect(saveCalls(api)).toHaveLength(1);

    // Retry succeeds and closes the dialog.
    api.opts.saveStatus = 200;
    await filename(app).focus();
    await app.keyboard.press("Enter");
    await expect(saveDialog(app)).toHaveCount(0);
    expect(saveCalls(api)).toHaveLength(2);
  });
});

test("D2 Tab and Shift+Tab stay inside the dialog and wrap", async ({ app }) => {
  await openDialog(app);
  const dlg = saveDialog(app);
  const stops = await dlg.evaluate(
    (el) =>
      Array.from(
        el.querySelectorAll<HTMLElement>("input, button, [tabindex]:not([tabindex='-1'])")
      ).filter((e) => !(e as HTMLButtonElement).disabled).length
  );
  const order: string[] = [];
  for (let i = 0; i < stops * 2; i++) {
    await app.keyboard.press("Tab");
    expect(
      await app.evaluate(() => Boolean(document.activeElement?.closest("[role='dialog']")))
    ).toBe(true);
    order.push(await focusedName(app));
  }
  expect(order.slice(0, stops)).toEqual(order.slice(stops)); // wrapped: a closed cycle
  expect(new Set(order).size).toBeGreaterThanOrEqual(4);
  await expect(dlg).toBeVisible();

  // Backward from the field wraps to the last control.
  await filename(app).focus();
  await app.keyboard.press("Shift+Tab");
  await app.keyboard.press("Shift+Tab");
  await expect(dlg.getByRole("button", { name: "Save", exact: true })).toBeFocused();
  await app.keyboard.press("Tab");
  await expect(dlg.getByRole("button", { name: "Close dialog" })).toBeFocused();
});

test("D2 focus that is outside the dialog is pulled back in by Tab and Shift+Tab", async ({
  app,
}) => {
  await openDialog(app);
  const dlg = saveDialog(app);
  const inside = () =>
    app.evaluate(() => Boolean(document.activeElement?.closest("[role='dialog']")));

  await app.getByRole("button", { name: "Open file" }).focus();
  expect(await inside()).toBe(false);
  await app.keyboard.press("Tab");
  expect(await inside()).toBe(true);
  await expect(dlg.getByRole("button", { name: "Close dialog" })).toBeFocused();

  await app.getByRole("button", { name: "Open file" }).focus();
  await app.keyboard.press("Shift+Tab");
  expect(await inside()).toBe(true);
  await expect(dlg.getByRole("button", { name: "Save", exact: true })).toBeFocused();
});

test("D3 Escape closes only the dialog and returns focus to the opener", async ({ app }) => {
  await openStudio(app);
  await saveButton(app).click();
  await expect(filename(app)).toBeFocused();
  await app.keyboard.press("Escape");
  await expect(saveDialog(app)).toHaveCount(0);
  await expect(studioShell(app)).toBeVisible();
  await expect(saveButton(app)).toBeFocused();

  // Also from another control inside the dialog.
  await saveButton(app).click();
  await replaceBox(app).focus();
  await app.keyboard.press("Escape");
  await expect(saveDialog(app)).toHaveCount(0);
  await expect(studioShell(app)).toBeVisible();
  await expect(saveButton(app)).toBeFocused();

  // A later Escape leaves the Studio.
  await app.keyboard.press("Escape");
  await expect(studioShell(app)).toHaveCount(0);
});

test.describe("slow save", () => {
  test.use({ apiOptions: { saveDelayMs: 800 } });
  test("D4 Enter in the filename field saves once; a second Enter during the save does nothing", async ({
    app,
    api,
  }) => {
    await openDialog(app);
    await app.keyboard.press("Enter");
    await expect(saveDialog(app).getByRole("button", { name: "Saving…" })).toBeDisabled();
    await app.keyboard.press("Enter");
    await app.keyboard.press("Enter");
    await expect(saveDialog(app)).toHaveCount(0);
    await flushApi(app);
    expect(saveCalls(api)).toHaveLength(1);
  });
});

test("D5 holding Enter on the Save to Library button opens the dialog without also saving", async ({
  app,
  api,
}) => {
  await openStudio(app);
  await saveButton(app).focus();
  await holdKey(app, "Enter", 8);
  await expect(saveDialog(app)).toBeVisible();
  await flushApi(app);
  expect(saveCalls(api)).toEqual([]);
  await expect(saveDialog(app)).toBeVisible();
});

test("D6 held Backspace and letters edit the filename normally", async ({ app }) => {
  await openDialog(app);
  const name = filename(app);
  await app.keyboard.press("Control+a");
  await app.keyboard.type("abcdefgh");
  await expect(name).toHaveValue("abcdefgh");
  await holdKey(app, "Backspace", 4);
  await expect(name).toHaveValue("abcd");
  await holdKey(app, "x", 4);
  await expect(name).toHaveValue("abcdxxxx");
  await expect(saveDialog(app)).toBeVisible();
});

test("D7 Ctrl/Cmd+S inside the dialog is blocked: no browser dialog, no second dialog, no save", async ({
  app,
  api,
}) => {
  await openDialog(app);
  const targets = [
    filename(app),
    replaceBox(app),
    saveDialog(app).getByRole("button", { name: "Cancel" }),
    saveDialog(app).getByRole("button", { name: "Close dialog" }),
  ];
  for (const t of targets) {
    await t.focus();
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(await keydownPrevented(app, { key: "s", code: "KeyS", ...mod })).toBe(true);
      expect(
        await keydownPrevented(app, { key: "s", code: "KeyS", repeat: true, ...mod })
      ).toBe(true);
    }
    await app.keyboard.press("Control+s");
    await app.keyboard.press("Meta+s");
    await expect(saveDialog(app)).toHaveCount(1);
  }
  await flushApi(app);
  expect(saveCalls(api)).toEqual([]);
});

test("D8 holding Space or Enter on the Replace file checkbox toggles it once per press", async ({
  app,
}) => {
  await openDialog(app);
  const cb = replaceBox(app);
  await cb.focus();
  await expect(cb).not.toBeChecked();

  await holdKey(app, "Space", 6);
  await expect(cb).toBeChecked();
  await holdKey(app, "Enter", 6);
  await expect(cb).not.toBeChecked();

  // Separate presses toggle each time.
  await app.keyboard.press("Space");
  await expect(cb).toBeChecked();
  await app.keyboard.press("Enter");
  await expect(cb).not.toBeChecked();
  await expect(saveDialog(app)).toBeVisible();
});

test("D10 the dialog closes when the loaded file changes", async ({ app }) => {
  await openDialog(app);
  // The scrim covers the toolbar, so trigger the Next-sound button directly.
  await app.getByRole("button", { name: "Next sound" }).dispatchEvent("click");
  await expect(app.locator(".sfx-editor-filename")).toHaveText("snd1.wav");
  await expect(saveDialog(app)).toHaveCount(0);
  await expect(studioShell(app)).toBeVisible();
});

test("D10 the dialog closes when a local file is loaded", async ({ app }) => {
  await openDialog(app);
  await app.locator("input[type=file][hidden]").setInputFiles({
    name: "other.wav",
    mimeType: "audio/wav",
    buffer: makeWav(1),
  });
  await expect(saveDialog(app)).toHaveCount(0);
  await expect(app.locator(".sfx-editor-shell")).toBeVisible();
});
