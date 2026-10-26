// Studio keyboard contract, rules S1-S12.
// Spec: docs/testing/keyboard-contract.md
import type { Page } from "@playwright/test";
import {
  expect,
  holdKey,
  keydownPrevented,
  makeWav,
  openStudio,
  row,
  saveCalls,
  saveDialog,
  statusbar,
  studioPlayButton,
  studioShell,
  test,
} from "./fixtures";

const tab = (page: Page, name: string) => page.getByRole("tab", { name });
const trimStart = (page: Page) => page.getByLabel("Trim Start (ms) value");
const trimEnd = (page: Page) => page.getByLabel("Trim End (ms) value");
const timeNow = (page: Page) => page.locator(".sfx-tp-time span").first();
const snapCheckbox = (page: Page) => page.getByRole("checkbox", { name: /Snap markers/ });
const outputGain = (page: Page) => page.getByLabel("Output Gain (dB)", { exact: true });

/** Drag a WAV over the library and drop it on the named drop target. */
async function dropFile(page: Page, target: string, name: string): Promise<void> {
  const dt = await page.evaluateHandle(
    ([b64, fileName]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], fileName, { type: "audio/wav" }));
      return data;
    },
    [makeWav(1).toString("base64"), name] as const
  );
  await page.locator(".sfx-shell").dispatchEvent("dragover", { dataTransfer: dt });
  const zone = page.locator(".sfx-drop-zone", { hasText: target });
  await zone.dispatchEvent("dragover", { dataTransfer: dt });
  await zone.dispatchEvent("drop", { dataTransfer: dt });
}

/** Count `new Worker(...)` calls from now on (the loop finder spawns one per run). */
async function countWorkers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __workers: number; Worker: typeof Worker };
    w.__workers = 0;
    const Orig = w.Worker;
    w.Worker = class extends Orig {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        w.__workers += 1;
      }
    };
  });
}
const workerCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { __workers: number }).__workers);

test.describe("Studio, nothing focused", () => {
  test.beforeEach(async ({ app }) => {
    await openStudio(app);
  });

  test("S1 Space plays and pauses", async ({ app }) => {
    await expect(studioPlayButton(app)).not.toHaveClass(/playing/);
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).not.toHaveClass(/playing/);
  });

  test("S1 holding Space does not toggle playback repeatedly", async ({ app }) => {
    await holdKey(app, "Space", 6);
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
  });

  test("S2 Digit1-4 switch the module", async ({ app }) => {
    await expect(tab(app, "Trim & Gain")).toHaveAttribute("aria-selected", "true");
    await app.keyboard.press("Digit2");
    await expect(tab(app, "Tone & EQ")).toHaveAttribute("aria-selected", "true");
    await expect(tab(app, "Trim & Gain")).toHaveAttribute("aria-selected", "false");
    await app.keyboard.press("Digit3");
    await expect(tab(app, "Seamless Loop")).toHaveAttribute("aria-selected", "true");
    await app.keyboard.press("Digit4");
    await expect(tab(app, "Variations")).toHaveAttribute("aria-selected", "true");
    await app.keyboard.press("Digit1");
    await expect(tab(app, "Trim & Gain")).toHaveAttribute("aria-selected", "true");
  });

  test("S3 [ and ] select the start and end marker (crop handles in Trim & Gain)", async ({
    app,
  }) => {
    await app.keyboard.press("BracketRight");
    await expect(statusbar(app)).toContainText("Active handle: Crop OUT");
    await app.keyboard.press("BracketLeft");
    await expect(statusbar(app)).toContainText("Active handle: Crop IN");

    await app.keyboard.press("Digit3");
    await app.keyboard.press("BracketRight");
    await expect(statusbar(app)).toContainText("Active marker: Loop End");
    await app.keyboard.press("BracketLeft");
    await expect(statusbar(app)).toContainText("Active marker: Loop Start");
  });

  test("S4 arrows nudge the active marker 1 ms, Shift 10 ms", async ({ app }) => {
    await expect(trimStart(app)).toHaveValue("0");
    await app.keyboard.press("ArrowRight");
    await expect(trimStart(app)).toHaveValue("1");
    await app.keyboard.press("Shift+ArrowRight");
    await expect(trimStart(app)).toHaveValue("11");
    await app.keyboard.press("ArrowLeft");
    await expect(trimStart(app)).toHaveValue("10");
    await app.keyboard.press("Shift+ArrowLeft");
    await expect(trimStart(app)).toHaveValue("0");

    // The end marker: moving it left trims more off the end.
    await app.keyboard.press("BracketRight");
    await expect(trimEnd(app)).toHaveValue("0");
    await app.keyboard.press("ArrowLeft");
    await expect(trimEnd(app)).toHaveValue("1");
    await app.keyboard.press("Shift+ArrowLeft");
    await expect(trimEnd(app)).toHaveValue("11");
    await app.keyboard.press("ArrowRight");
    await expect(trimEnd(app)).toHaveValue("10");
    await expect(trimStart(app), "the start marker was not touched").toHaveValue("0");
  });

  test("S4 nudging the loop markers in Seamless Loop shows the new position", async ({ app }) => {
    await app.keyboard.press("Digit3");
    await expect(app.locator(".sfx-hud-pill.start")).toContainText("S 0.000s");
    await app.keyboard.press("Shift+ArrowRight");
    await expect(app.locator(".sfx-hud-pill.start")).toContainText("S 0.010s");
    await app.keyboard.press("BracketRight");
    const end = app.locator(".sfx-hud-pill.end");
    const before = (await end.textContent()) ?? "";
    await app.keyboard.press("Shift+ArrowLeft");
    await expect(end).not.toHaveText(before);
    await expect(app.locator(".sfx-hud-pill.start")).toContainText("S 0.010s");
  });

  test("S4 auto-repeat keeps nudging", async ({ app }) => {
    await holdKey(app, "ArrowRight", 6);
    await expect(trimStart(app)).toHaveValue("6");
    await app.keyboard.down("Shift");
    await holdKey(app, "ArrowRight", 3);
    await app.keyboard.up("Shift");
    await expect(trimStart(app)).toHaveValue("36");
  });

  test("S6 S auditions the loop seam", async ({ app }) => {
    await app.keyboard.press("Digit3");
    await expect(studioPlayButton(app)).not.toHaveClass(/playing/);
    await app.keyboard.press("s");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
    await expect(statusbar(app)).toContainText("Auditioning loop seam");
  });

  test("S6 S and the Test Seam button are Seamless Loop only", async ({ app }) => {
    const testSeam = app.getByRole("button", { name: "Test Seam" });
    // Nudging a loop marker enables the loop; the button must still stay in its module.
    await app.keyboard.press("Digit3");
    await app.keyboard.press("ArrowRight");
    await expect(testSeam).toBeVisible();
    for (const digit of ["Digit1", "Digit2", "Digit4"]) {
      await app.keyboard.press(digit);
      await expect(testSeam).toHaveCount(0);
      await app.keyboard.press("s");
      await expect(studioPlayButton(app)).not.toHaveClass(/playing/);
    }
    await app.keyboard.press("Digit3");
    await expect(testSeam).toBeVisible();
  });

  test("S3/S4/S6 marker keys and F do nothing in modules without markers", async ({ app }) => {
    for (const digit of ["Digit2", "Digit4"]) {
      await app.keyboard.press(digit);
      for (const code of ["BracketLeft", "ArrowRight", "KeyF"]) {
        expect(await keydownPrevented(app, { code, key: code === "KeyF" ? "f" : code })).toBe(false);
      }
      await expect(statusbar(app)).not.toContainText(/find loops/i);
      await expect(statusbar(app)).not.toContainText(/nudge/i);
    }
  });

  test("S6 F runs the loop search", async ({ app }) => {
    await countWorkers(app);
    await app.keyboard.press("Digit3");
    await app.keyboard.press("f");
    await expect.poll(() => workerCount(app)).toBe(1);
    // The search completes and reports something.
    await expect(statusbar(app)).not.toContainText(/Scanning audio/, { timeout: 15_000 });
  });

  test("S6 Home restarts the loop", async ({ app }) => {
    await app.keyboard.press("Digit3");
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
    await expect(timeNow(app)).not.toHaveText("0:00.00");
    await app.keyboard.press("Space"); // pause with the playhead parked mid-file
    await expect(studioPlayButton(app)).not.toHaveClass(/playing/);
    const parked = await timeNow(app).textContent();
    expect(parked).not.toBe("0:00.00");

    await app.keyboard.press("Home");
    await expect(timeNow(app)).toHaveText("0:00.00");
  });

  test("S6 Home while playing keeps playing from the start", async ({ app }) => {
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
    await expect
      .poll(async () => (await timeNow(app).textContent()) !== "0:00.00")
      .toBe(true);
    await app.keyboard.press("Home");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
  });

  test("S11 Ctrl/Cmd/Alt chords are not handled and not preventDefault'd", async ({ app }) => {
    const chords = [
      { key: "1", code: "Digit1", ctrlKey: true },
      { key: "2", code: "Digit2", metaKey: true },
      { key: "3", code: "Digit3", altKey: true },
      { key: "ArrowLeft", code: "ArrowLeft", metaKey: true },
      { key: "ArrowRight", code: "ArrowRight", ctrlKey: true },
      { key: "ArrowRight", code: "ArrowRight", altKey: true },
      { key: " ", code: "Space", ctrlKey: true },
      { key: "f", code: "KeyF", ctrlKey: true },
      { key: "f", code: "KeyF", altKey: true },
      { key: "s", code: "KeyS", altKey: true },
      { key: "[", code: "BracketLeft", ctrlKey: true },
      { key: "Home", code: "Home", metaKey: true },
      { key: "z", code: "KeyZ", ctrlKey: true },
    ];
    await countWorkers(app);
    for (const c of chords) {
      expect(await keydownPrevented(app, c), JSON.stringify(c)).toBe(false);
    }
    // And nothing happened.
    await expect(tab(app, "Trim & Gain")).toHaveAttribute("aria-selected", "true");
    await expect(trimStart(app)).toHaveValue("0");
    await expect(studioPlayButton(app)).not.toHaveClass(/playing/);
    await expect(saveDialog(app)).toHaveCount(0);
    expect(await workerCount(app)).toBe(0);

    // Real keyboard too.
    await app.keyboard.press("Control+2");
    await app.keyboard.press("Alt+ArrowRight");
    await app.keyboard.press("Meta+ArrowLeft");
    await expect(tab(app, "Trim & Gain")).toHaveAttribute("aria-selected", "true");
    await expect(trimStart(app)).toHaveValue("0");
    await expect(studioShell(app)).toBeVisible();
  });

  test("S12 Escape leaves the Studio and returns to the library", async ({ app }) => {
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
    await app.keyboard.press("Escape");
    await expect(studioShell(app)).toHaveCount(0);
    await expect(row(app, 0)).toBeVisible();
    // Library shortcuts work again.
    await app.keyboard.press("ArrowDown");
    await expect(row(app, 1)).toHaveClass(/selected/);
  });
});

test.describe("Studio, save chord (S5)", () => {
  test("S5 Ctrl+S and Cmd+S open the save dialog for a library file", async ({ app }) => {
    await openStudio(app);
    await app.keyboard.press("Control+s");
    await expect(saveDialog(app)).toBeVisible();
    await app.keyboard.press("Escape");
    await expect(saveDialog(app)).toHaveCount(0);
    await app.keyboard.press("Meta+s");
    await expect(saveDialog(app)).toBeVisible();
  });

  test("S5 the chord is preventDefault'd, including on auto-repeat, and does not stack dialogs", async ({
    app,
    api,
  }) => {
    await openStudio(app);
    expect(await keydownPrevented(app, { key: "s", code: "KeyS", ctrlKey: true })).toBe(true);
    await expect(saveDialog(app)).toHaveCount(1);
    // Auto-repeat while the dialog is open: still blocked, no second dialog, no save.
    expect(
      await keydownPrevented(app, { key: "s", code: "KeyS", ctrlKey: true, repeat: true })
    ).toBe(true);
    await expect(saveDialog(app)).toHaveCount(1);
    expect(saveCalls(api)).toEqual([]);
  });

  test("S5 auto-repeat of the chord is blocked from the browser and opens nothing by itself", async ({
    app,
  }) => {
    await openStudio(app);
    expect(
      await keydownPrevented(app, { key: "s", code: "KeyS", ctrlKey: true, repeat: true })
    ).toBe(true);
    expect(
      await keydownPrevented(app, { key: "S", code: "KeyS", metaKey: true, repeat: true })
    ).toBe(true);
    await expect(saveDialog(app)).toHaveCount(0);
  });

  test.describe("audio still decoding", () => {
    test.use({ apiOptions: { hangAudio: true } });
    test("S5 the chord never reaches the browser while audio is still decoding", async ({
      app,
      api,
    }) => {
      await openStudio(app, { waitDecoded: false });
      await expect(app.getByRole("button", { name: "Export WAV" })).toBeDisabled();
      expect(await keydownPrevented(app, { key: "s", code: "KeyS", ctrlKey: true })).toBe(true);
      expect(await keydownPrevented(app, { key: "s", code: "KeyS", metaKey: true })).toBe(true);
      expect(
        await keydownPrevented(app, { key: "s", code: "KeyS", ctrlKey: true, repeat: true })
      ).toBe(true);
      await expect(saveDialog(app)).toHaveCount(0);
      expect(saveCalls(api)).toEqual([]);
    });
  });

  test("S5 Ctrl+Shift+S and Ctrl+Alt+S are not the save chord", async ({ app }) => {
    await openStudio(app);
    await app.keyboard.press("Control+Shift+S");
    await app.keyboard.press("Control+Alt+s");
    await expect(saveDialog(app)).toHaveCount(0);
    expect(
      await keydownPrevented(app, { key: "S", code: "KeyS", ctrlKey: true, shiftKey: true })
    ).toBe(false);
    expect(
      await keydownPrevented(app, { key: "s", code: "KeyS", ctrlKey: true, altKey: true })
    ).toBe(false);
    await expect(saveDialog(app)).toHaveCount(0);
  });

  test("S5 the chord is matched on the typed key, not the physical key", async ({ app }) => {
    await openStudio(app);
    // Another layout: the typed "o" sits on the physical S position -> not a save.
    expect(await keydownPrevented(app, { key: "o", code: "KeyS", ctrlKey: true })).toBe(false);
    await expect(saveDialog(app)).toHaveCount(0);
    // The typed "s" sits on the physical O position -> save.
    expect(await keydownPrevented(app, { key: "s", code: "KeyO", ctrlKey: true })).toBe(true);
    await expect(saveDialog(app)).toBeVisible();
  });

  test("a file dropped on Find similar sounds searches by it and stays in the library", async ({
    app,
    api,
  }) => {
    await dropFile(app, "Find similar sounds", "ref.wav");
    await expect.poll(() => api.callsTo("POST /api/similar/upload").length).toBe(1);
    await expect(studioShell(app)).toHaveCount(0);
  });

  test("S5 without a library file (local file) Ctrl+S downloads instead of opening the dialog", async ({
    app,
  }) => {
    await dropFile(app, "Edit in Studio", "local.wav");
    await expect(studioShell(app)).toBeVisible();
    await expect(app.getByRole("button", { name: "Save to Library" })).toHaveCount(0);
    await expect(app.getByRole("button", { name: "Export WAV" })).toBeEnabled();
    await expect(app.locator(".sfx-editor-filename")).toHaveText("local.wav");

    const download = app.waitForEvent("download");
    await app.keyboard.press("Control+s");
    expect((await download).suggestedFilename()).toMatch(/^local.*\.wav$/);
    await expect(saveDialog(app)).toHaveCount(0);
  });
});

test.describe("Studio, focused controls", () => {
  test.beforeEach(async ({ app }) => {
    await openStudio(app);
  });

  test("S7 a focused slider handles arrows/Home/End/PageUp/PageDown natively, without nudging a marker", async ({
    app,
  }) => {
    const gain = outputGain(app);
    await gain.focus();
    const value = async () => Number(await gain.inputValue());
    const min = Number(await gain.getAttribute("min"));
    const max = Number(await gain.getAttribute("max"));
    const step = Number(await gain.getAttribute("step"));
    const start = await value();

    await app.keyboard.press("ArrowRight");
    expect(await value()).toBeCloseTo(start + step, 5);
    await app.keyboard.press("ArrowUp");
    expect(await value()).toBeCloseTo(start + 2 * step, 5);
    await app.keyboard.press("ArrowLeft");
    await app.keyboard.press("ArrowDown");
    expect(await value()).toBeCloseTo(start, 5);
    await app.keyboard.press("End");
    expect(await value()).toBe(max);
    await app.keyboard.press("Home");
    expect(await value()).toBe(min);
    await app.keyboard.press("PageUp");
    expect(await value()).toBeGreaterThan(min);
    await app.keyboard.press("PageDown");
    expect(await value()).toBe(min);

    await expect(trimStart(app), "no marker nudge").toHaveValue("0");
    await expect(trimEnd(app), "no marker nudge").toHaveValue("0");
    await expect(studioPlayButton(app), "Home must not restart/play").not.toHaveClass(/playing/);
    await expect(gain).toBeFocused();
  });

  test("S7 arrows on the trim slider move only that slider", async ({ app }) => {
    const slider = app.getByLabel("Trim Start (ms)", { exact: true });
    await slider.focus();
    await app.keyboard.press("ArrowRight");
    await expect(trimStart(app)).toHaveValue("5"); // slider step is 5, not a 1 ms marker nudge
    await app.keyboard.press("Shift+ArrowRight");
    await expect(trimStart(app)).toHaveValue("10"); // native slider ignores Shift; still 5 ms/step
    await expect(trimEnd(app)).toHaveValue("0");
  });

  test("S8 on a focused slider Space, Digit1-4 and Ctrl/Cmd+S still work", async ({ app }) => {
    const gain = outputGain(app);
    await gain.focus();
    const before = await gain.inputValue();

    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).not.toHaveClass(/playing/);

    await app.keyboard.press("Control+s");
    await expect(saveDialog(app)).toBeVisible();
    await app.keyboard.press("Escape");
    await expect(saveDialog(app)).toHaveCount(0);

    await gain.focus();
    await app.keyboard.press("Meta+s");
    await expect(saveDialog(app)).toBeVisible();
    await app.keyboard.press("Escape");

    await gain.focus();
    await app.keyboard.press("Digit3");
    await expect(tab(app, "Seamless Loop")).toHaveAttribute("aria-selected", "true");
    await app.keyboard.press("Digit2");
    await expect(tab(app, "Tone & EQ")).toHaveAttribute("aria-selected", "true");
    await app.keyboard.press("Digit4");
    await expect(tab(app, "Variations")).toHaveAttribute("aria-selected", "true");
    await app.keyboard.press("Digit1");
    await expect(tab(app, "Trim & Gain")).toHaveAttribute("aria-selected", "true");
    await expect(outputGain(app)).toHaveValue(before);
  });

  test("S9 a focused checkbox toggles with Space and Enter, once per press, without playing", async ({
    app,
  }) => {
    await app.keyboard.press("Digit3");
    const cb = snapCheckbox(app);
    await expect(cb).toBeChecked(); // zero-crossing snap defaults to on
    await cb.focus();

    await app.keyboard.press("Space");
    await expect(cb).not.toBeChecked();
    await app.keyboard.press("Enter");
    await expect(cb).toBeChecked();
    await app.keyboard.press("Space");
    await expect(cb).not.toBeChecked();
    await expect(studioPlayButton(app), "Space on a checkbox must not play").not.toHaveClass(
      /playing/
    );
    await expect(tab(app, "Seamless Loop")).toHaveAttribute("aria-selected", "true");
  });

  test("S9 holding Space or Enter on a checkbox toggles it once", async ({ app }) => {
    await app.keyboard.press("Digit3");
    const cb = snapCheckbox(app);
    await cb.focus();
    await expect(cb).toBeChecked();
    await holdKey(app, "Space", 5);
    await expect(cb).not.toBeChecked();
    await holdKey(app, "Enter", 5);
    await expect(cb).toBeChecked();
  });

  test("S10 typing digits and letters in a number input types them without shortcuts", async ({
    app,
  }) => {
    const input = trimStart(app);
    await input.focus();
    await app.keyboard.press("Control+a");
    await countWorkers(app);
    await app.keyboard.type("1234");
    await expect(input).toHaveValue("1234");
    await app.keyboard.type("f", { delay: 0 });
    await app.keyboard.press("Home");
    await app.keyboard.press("BracketRight");
    await app.keyboard.press("Space");
    await expect(input).toBeFocused();
    await expect(tab(app, "Trim & Gain")).toHaveAttribute("aria-selected", "true");
    await expect(studioPlayButton(app)).not.toHaveClass(/playing/);
    await expect(saveDialog(app)).toHaveCount(0);
    expect(await workerCount(app)).toBe(0);
    await expect(statusbar(app)).not.toContainText("Active handle");
  });

  test("S10 Ctrl/Cmd+S still opens save from a focused number input", async ({ app }) => {
    await trimStart(app).focus();
    await app.keyboard.press("Control+s");
    await expect(saveDialog(app)).toBeVisible();
    await app.keyboard.press("Escape");
    await expect(saveDialog(app)).toHaveCount(0);
    await trimStart(app).focus();
    await app.keyboard.press("Meta+s");
    await expect(saveDialog(app)).toBeVisible();
  });

  test("S10 typing in the dialog's filename field never switches module or fires shortcuts", async ({
    app,
  }) => {
    await countWorkers(app);
    await app.keyboard.press("Control+s");
    const name = saveDialog(app).getByLabel("Filename");
    await expect(name).toBeFocused();
    await app.keyboard.press("Control+a");
    await app.keyboard.type("s1f2 3e4 [x]");
    await expect(name).toHaveValue("s1f2 3e4 [x]");
    await expect(tab(app, "Trim & Gain")).toHaveAttribute("aria-selected", "true");
    await expect(studioPlayButton(app)).not.toHaveClass(/playing/);
    expect(await workerCount(app)).toBe(0);
    await expect(saveDialog(app)).toBeVisible();
  });

  test("S12 Escape on a focused slider blurs it first, a second Escape leaves the Studio", async ({
    app,
  }) => {
    const gain = outputGain(app);
    await gain.focus();
    await app.keyboard.press("Escape");
    await expect(gain).not.toBeFocused();
    await expect(studioShell(app)).toBeVisible();
    await app.keyboard.press("Escape");
    await expect(studioShell(app)).toHaveCount(0);
  });

  test("S12 Escape on a focused checkbox blurs it first, a second Escape leaves the Studio", async ({
    app,
  }) => {
    await app.keyboard.press("Digit3");
    const cb = snapCheckbox(app);
    await cb.focus();
    await app.keyboard.press("Escape");
    await expect(cb).not.toBeFocused();
    await expect(studioShell(app)).toBeVisible();
    await app.keyboard.press("Escape");
    await expect(studioShell(app)).toHaveCount(0);
  });
});
