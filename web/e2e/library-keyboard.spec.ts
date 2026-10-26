// Library-view keyboard contract, rules L1-L19.
// Spec: docs/testing/keyboard-contract.md
import type { Page } from "@playwright/test";
import {
  expect,
  focusedName,
  foldersModal,
  inspector,
  playingIndex,
  row,
  selectedIndex,
  statusbar,
  studioShell,
  tabTo,
  test,
} from "./fixtures";

const searchBox = (page: Page) => page.getByLabel("Search sounds");
const foldersButton = (page: Page) => page.getByRole("button", { name: /^Folders/ });
const selectTrigger = (page: Page, label: string) =>
  page.getByRole("button", { name: label, exact: true });
const popup = (page: Page) => page.locator(".ds-select-pop");
const isAudioPaused = (page: Page) =>
  page.evaluate(() => document.querySelector("audio")?.paused ?? true);

const pathField = (page: Page) => page.getByRole("textbox", { name: "Folder path" });

async function openPathField(page: Page): Promise<void> {
  await page.getByRole("button", { name: "or paste a path" }).click();
  await expect(pathField(page)).toBeFocused();
}

/** Load the app with a controllable clock (for the ~3 s / ~5 s timers). */
async function loadWithClock(page: Page): Promise<void> {
  await page.clock.install();
  await page.goto("/");
  await page.locator(".sfx-row").first().waitFor();
}

async function openFolders(page: Page): Promise<void> {
  await foldersButton(page).click();
  await expect(foldersModal(page)).toBeVisible();
}

test.describe("results navigation and actions", () => {
  test("L1 ArrowDown/ArrowUp move the selection one row, clamped, and scroll it into view", async ({
    app,
  }) => {
    expect(await selectedIndex(app)).toBe(0);
    await app.keyboard.press("ArrowUp");
    expect(await selectedIndex(app), "clamped at the first row").toBe(0);
    await app.keyboard.press("ArrowDown");
    expect(await selectedIndex(app)).toBe(1);
    await app.keyboard.press("ArrowDown");
    expect(await selectedIndex(app)).toBe(2);
    await app.keyboard.press("ArrowUp");
    expect(await selectedIndex(app)).toBe(1);

    for (let i = 0; i < 25; i++) await app.keyboard.press("ArrowDown");
    expect(await selectedIndex(app)).toBe(26);
    await expect(row(app, 26)).toBeInViewport();
    await expect(row(app, 0), "the list scrolled to follow the selection").not.toBeInViewport();
  });

  test("L1 ArrowDown past the loaded rows loads more results", async ({ app, api }) => {
    expect(await app.locator(".sfx-row").count()).toBe(50);
    for (let i = 0; i < 52; i++) await app.keyboard.press("ArrowDown");
    await expect.poll(() => app.locator(".sfx-row").count()).toBeGreaterThan(50);
    expect(api.callsTo("POST /api/search").length).toBeGreaterThan(1);
    await app.keyboard.press("ArrowDown");
    expect(await selectedIndex(app)).toBe(53);
  });

  test.describe("short list", () => {
    test.use({ apiOptions: { total: 4 } });
    test("L1 ArrowDown is clamped at the last row", async ({ app }) => {
      for (let i = 0; i < 8; i++) await app.keyboard.press("ArrowDown");
      expect(await selectedIndex(app)).toBe(3);
    });
  });

  test("L2 Space plays the selected row at its best-chunk offset and pauses it again", async ({
    app,
  }) => {
    await app.keyboard.press("Space");
    await expect(row(app, 0)).toHaveClass(/is-playing/);
    const state = await app.evaluate(() => {
      const a = document.querySelector("audio");
      return { src: a?.getAttribute("src") ?? "", t: a?.currentTime ?? 0 };
    });
    expect(state.src).toContain("/api/audio/f0");
    expect(state.t, "starts at the best-chunk offset (0.5 s)").toBeGreaterThanOrEqual(0.45);

    await app.keyboard.press("Space");
    await expect(row(app, 0)).not.toHaveClass(/is-playing/);
    expect(await playingIndex(app)).toBe(-1);
  });

  test("L2 starting another row stops the first (one audio stream)", async ({ app }) => {
    await app.keyboard.press("Space");
    await expect(row(app, 0)).toHaveClass(/is-playing/);
    await app.keyboard.press("ArrowDown");
    await app.keyboard.press("Space");
    await expect(row(app, 1)).toHaveClass(/is-playing/);
    await expect(row(app, 0)).not.toHaveClass(/is-playing/);
    expect(await app.locator(".sfx-row.is-playing").count()).toBe(1);
    expect(await app.locator("audio").count()).toBe(1);
  });

  test("L3 Enter toggles the inspector panel", async ({ app }) => {
    await expect(inspector(app)).toBeVisible();
    await app.keyboard.press("Enter");
    await expect(inspector(app)).toBeHidden();
    await app.keyboard.press("Enter");
    await expect(inspector(app)).toBeVisible();
  });

  test("L4 F toggles favorite on the selected row", async ({ app, api }) => {
    await app.keyboard.press("ArrowDown");
    await app.keyboard.press("f");
    await expect(row(app, 1).getByRole("button", { name: "Remove from favorites" })).toBeVisible();
    expect([...api.favorites]).toEqual(["f1"]);
    await app.keyboard.press("f");
    await expect(row(app, 1).getByRole("button", { name: "Add to favorites" })).toBeVisible();
    expect([...api.favorites]).toEqual([]);
  });

  test("L5 R reveals the selected file", async ({ app, api }) => {
    await app.keyboard.press("ArrowDown");
    await app.keyboard.press("r");
    await expect.poll(() => api.callsTo("POST /api/files/f1/reveal").length).toBe(1);
    await expect(statusbar(app)).not.toContainText(/reveal.*(failed|could not)|could not reveal/i);
  });

  test.describe("reveal fails", () => {
    test.use({ apiOptions: { failReveal: true } });
    test("L5 a failed reveal shows an error in the footer", async ({ app, api }) => {
      await app.keyboard.press("r");
      await expect.poll(() => api.callsTo("POST /api/files/f0/reveal").length).toBe(1);
      await expect(statusbar(app)).toContainText("Reveal failed");
    });
  });

  test("L6 / focuses the search box without typing a slash", async ({ app }) => {
    await expect(searchBox(app)).not.toBeFocused();
    await app.keyboard.press("/");
    await expect(searchBox(app)).toBeFocused();
    await expect(searchBox(app)).toHaveValue("");
  });

  test("L6 / works from a focused button, and typing is never hijacked in a text field", async ({
    app,
  }) => {
    await row(app, 0).getByRole("button", { name: "Add to favorites" }).focus();
    await app.keyboard.press("/");
    await expect(searchBox(app)).toBeFocused();

    // Typing shortcut keys into the search box types them; nothing else fires.
    const before = await selectedIndex(app);
    await app.keyboard.type("a/b f r e ");
    await expect(searchBox(app)).toHaveValue("a/b f r e ");
    expect(await selectedIndex(app)).toBe(before);
    await expect(studioShell(app)).toHaveCount(0);
    expect(await playingIndex(app)).toBe(-1);
  });

  test("L7 Escape blurs the search box and library shortcuts work again", async ({ app }) => {
    await app.keyboard.press("/");
    await expect(searchBox(app)).toBeFocused();
    await app.keyboard.type("door");
    await app.keyboard.press("ArrowDown"); // inside the box: must not move the selection
    expect(await selectedIndex(app)).toBe(0);
    await app.keyboard.press("Escape");
    await expect(searchBox(app)).not.toBeFocused();
    await expect(searchBox(app)).toHaveValue("door");
    await app.keyboard.press("ArrowDown");
    expect(await selectedIndex(app)).toBe(1);
    await app.keyboard.press("Space");
    await expect(row(app, 1)).toHaveClass(/is-playing/);
  });

  test("L8 E opens the Studio on the selected row and library audio pauses", async ({ app }) => {
    await app.keyboard.press("ArrowDown");
    await app.keyboard.press("Space");
    await expect(row(app, 1)).toHaveClass(/is-playing/);
    await app.keyboard.press("e");
    await expect(studioShell(app)).toBeVisible();
    await expect(app.locator(".sfx-editor-filename")).toHaveText("snd1.wav");
    expect(await isAudioPaused(app)).toBe(true);
  });
});

test.describe("focus handling around mouse and Tab", () => {
  for (const name of ["Play", "Reveal file in Explorer", "Find similar sounds", "Add to favorites"]) {
    test(`L9 after a mouse click on the row's "${name}" button, arrows/Enter/Space act on the library`, async ({
      app,
      api,
    }) => {
      const r = 2;
      await row(app, r).getByRole("button", { name, exact: true }).click();
      if (name === "Find similar sounds") {
        await expect(statusbar(app)).toContainText("Similar to");
      }
      await expect(app.locator(".sfx-row button:focus"), "click released focus").toHaveCount(0);
      const sel = await selectedIndex(app);
      const inspectorWasOpen = await inspector(app).isVisible();
      const callsBefore = api.calls.length;

      await app.keyboard.press("ArrowDown");
      expect(await selectedIndex(app)).toBe(sel + 1);

      await app.keyboard.press("Enter");
      if (inspectorWasOpen) await expect(inspector(app)).toBeHidden();
      else await expect(inspector(app)).toBeVisible();

      await app.keyboard.press("Space");
      await expect(row(app, sel + 1)).toHaveClass(/is-playing/);
      expect(await playingIndex(app)).toBe(sel + 1);

      // The clicked button was not re-activated by Enter/Space.
      const extra = api.calls
        .slice(callsBefore)
        .filter((c) => /\/reveal|\/user|\/similar\//.test(c));
      expect(extra, "no repeated button action").toEqual([]);
    });
  }

  test("L9 after a mouse click on the row's Edit button the Studio opens and Escape returns to a keyboard-ready library", async ({
    app,
  }) => {
    await row(app, 1).getByRole("button", { name: "Edit audio" }).click();
    await expect(studioShell(app)).toBeVisible();
    await app.keyboard.press("Escape");
    await expect(studioShell(app)).toHaveCount(0);
    const sel = await selectedIndex(app);
    await app.keyboard.press("ArrowDown");
    expect(await selectedIndex(app)).toBe(sel + 1);
    await app.keyboard.press("Enter");
    await expect(inspector(app)).toBeHidden();
    await app.keyboard.press("Space");
    expect(await playingIndex(app)).toBe(sel + 1);
  });

  test("L10 a row button focused by Tab is activated by Space/Enter, and only that button", async ({
    app,
    api,
  }) => {
    // Play: Space plays, Enter pauses; neither also triggers the library shortcut.
    const play = row(app, 0).getByRole("button", { name: /^(Play|Pause)$/ });
    await tabTo(app, play);
    await app.keyboard.press("Space");
    await expect(row(app, 0)).toHaveClass(/is-playing/);
    await expect(inspector(app), "Space on a button must not toggle anything else").toBeVisible();
    await app.keyboard.press("Enter");
    await expect(row(app, 0)).not.toHaveClass(/is-playing/);
    await expect(inspector(app), "Enter on a button must not toggle the inspector").toBeVisible();

    // Reveal: Enter activates exactly once and does not toggle the inspector or play.
    const reveal = row(app, 0).getByRole("button", { name: "Reveal file in Explorer" });
    await tabTo(app, reveal);
    await app.keyboard.press("Enter");
    await expect.poll(() => api.callsTo("POST /api/files/f0/reveal").length).toBe(1);
    await expect(inspector(app)).toBeVisible();
    expect(await playingIndex(app)).toBe(-1);

    // Favorite: Space toggles favorite once, without playing the row.
    const fav = row(app, 0).getByRole("button", { name: /favorites$/ });
    await tabTo(app, fav);
    await app.keyboard.press("Space");
    await expect.poll(() => [...api.favorites]).toEqual(["f0"]);
    expect(await playingIndex(app)).toBe(-1);
    await expect(inspector(app)).toBeVisible();
  });

  test("L11 after picking a dropdown option by mouse then clicking a waveform, Space plays/pauses and the dropdown stays closed", async ({
    app,
  }) => {
    await selectTrigger(app, "Search mode").click();
    await app.getByRole("option", { name: "Audio (CLAP)" }).click();
    await expect(popup(app)).toHaveCount(0);
    await expect(selectTrigger(app, "Search mode")).toContainText("Audio (CLAP)");
    await expect(row(app, 1)).toBeVisible();

    await row(app, 1).locator(".sfx-row-wave").click();
    await expect(row(app, 1)).toHaveClass(/is-playing/);
    await app.keyboard.press("Space");
    await expect(row(app, 1)).not.toHaveClass(/is-playing/);
    await expect(popup(app)).toHaveCount(0);
    await app.keyboard.press("Space");
    await expect(row(app, 1)).toHaveClass(/is-playing/);
    await expect(popup(app)).toHaveCount(0);
  });
});

test.describe("dropdowns (DsSelect)", () => {
  test("L12 arrows/Home/End move between options and the results selection stays put", async ({
    app,
  }) => {
    for (let i = 0; i < 3; i++) await app.keyboard.press("ArrowDown");
    expect(await selectedIndex(app)).toBe(3);

    await selectTrigger(app, "Sort order").click();
    await expect(popup(app)).toBeVisible();
    const options = popup(app).getByRole("option");
    const n = await options.count();
    expect(n).toBeGreaterThan(3);
    await expect(options.first()).toBeFocused(); // current value "relevance" is first

    await app.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toBeFocused();
    await app.keyboard.press("ArrowDown");
    await expect(options.nth(2)).toBeFocused();
    await app.keyboard.press("ArrowUp");
    await expect(options.nth(1)).toBeFocused();
    await app.keyboard.press("End");
    await expect(options.nth(n - 1)).toBeFocused();
    await app.keyboard.press("ArrowDown"); // clamped
    await expect(options.nth(n - 1)).toBeFocused();
    await app.keyboard.press("Home");
    await expect(options.first()).toBeFocused();
    await app.keyboard.press("ArrowUp"); // clamped
    await expect(options.first()).toBeFocused();

    expect(await selectedIndex(app)).toBe(3);
    await expect(popup(app)).toBeVisible();
  });

  test("L13 Escape closes only the dropdown, keeps the inspector open and refocuses the trigger", async ({
    app,
  }) => {
    await expect(inspector(app)).toBeVisible();
    const trigger = selectTrigger(app, "Search mode");
    await trigger.click();
    await expect(popup(app)).toBeVisible();
    await app.keyboard.press("ArrowDown");
    await app.keyboard.press("Escape");
    await expect(popup(app)).toHaveCount(0);
    await expect(inspector(app)).toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText("Hybrid");
  });

  test("L14 Enter and Space on an option select it, close the dropdown and focus the trigger", async ({
    app,
  }) => {
    const trigger = selectTrigger(app, "Sort order");

    await trigger.click();
    await app.keyboard.press("ArrowDown");
    await app.keyboard.press("Enter");
    await expect(popup(app)).toHaveCount(0);
    await expect(trigger).toContainText("Name (A–Z)");
    await expect(trigger).toBeFocused();
    await expect(inspector(app), "Enter must not also toggle the inspector").toBeVisible();

    await trigger.click();
    await expect(popup(app)).toBeVisible();
    await expect(app.getByRole("option", { name: "Name (A–Z)" })).toBeFocused();
    await app.keyboard.press("ArrowDown");
    await app.keyboard.press("Space");
    await expect(popup(app)).toHaveCount(0);
    await expect(trigger).toContainText("Name (Z–A)");
    await expect(trigger).toBeFocused();
    expect(await playingIndex(app), "Space must not also play the row").toBe(-1);
  });

  test("L14 Tab closes the dropdown without selecting", async ({ app }) => {
    const trigger = selectTrigger(app, "Sort order");
    await trigger.click();
    await app.keyboard.press("ArrowDown");
    await expect(popup(app)).toBeVisible();
    await app.keyboard.press("Tab");
    await expect(popup(app)).toHaveCount(0);
    await expect(trigger).toContainText("Relevance");
  });
});

test.describe("Library (folders) modal", () => {
  /** Collect the focus order over `steps` Tab presses. */
  async function focusCycle(page: Page, key: string, steps: number): Promise<string[]> {
    const seen: string[] = [];
    for (let i = 0; i < steps; i++) {
      await page.keyboard.press(key);
      const inside = await page.evaluate(() =>
        Boolean(document.activeElement?.closest("[role='dialog']"))
      );
      expect(inside, `focus escaped the modal on step ${i + 1}`).toBe(true);
      seen.push(await focusedName(page));
    }
    return seen;
  }

  test("L15 Tab and Shift+Tab stay inside the modal and wrap", async ({ app }) => {
    await openFolders(app);
    await expect(app.getByRole("button", { name: "Close dialog" })).toBeFocused();

    const forward = await focusCycle(app, "Tab", 14);
    // Wraps: the same sequence repeats and covers the first and last controls.
    expect(forward).toContain("Done");
    expect(forward.slice(0, 7)).toEqual(forward.slice(7, 14));
    expect(forward.filter((n) => n === "Close dialog").length).toBeGreaterThanOrEqual(2);

    // Shift+Tab from the first control wraps to the last one.
    await app.getByRole("button", { name: "Close dialog" }).focus();
    await app.keyboard.press("Shift+Tab");
    await expect(app.getByRole("button", { name: "Done" })).toBeFocused();
    const backward = await focusCycle(app, "Shift+Tab", 10);
    expect(backward).toContain("Close dialog");
  });

  test("L15 a focus that starts outside the modal is pulled back in", async ({ app }) => {
    await openFolders(app);
    await app.locator(".sfx-row").first().getByRole("button", { name: "Play" }).focus();
    await app.keyboard.press("Tab");
    expect(
      await app.evaluate(() => Boolean(document.activeElement?.closest("[role='dialog']")))
    ).toBe(true);
  });

  test.describe("while a scan runs", () => {
    test.use({ apiOptions: { indexing: true } });
    test("L15 disabled controls are skipped by Tab", async ({ app }) => {
      await openFolders(app);
      for (const name of ["Remove", "Scan for changes", "Rebuild all"]) {
        await expect(app.getByRole("button", { name })).toBeDisabled();
      }
      const forward = await focusCycle(app, "Tab", 10);
      for (const skipped of ["Remove", "Scan for changes", "Rebuild all"]) {
        expect(forward).not.toContain(skipped);
      }
      expect(forward).toContain("Done");
      const backward = await focusCycle(app, "Shift+Tab", 10);
      for (const skipped of ["Remove", "Scan for changes", "Rebuild all"]) {
        expect(backward).not.toContain(skipped);
      }
    });
  });

  test("L16 Escape closes the modal, restores focus to the opener, and shortcuts are inert while open", async ({
    app,
    api,
  }) => {
    await openFolders(app);
    const callsBefore = api.calls.length;

    // Move focus into the text field so Space/Enter cannot activate a button.
    await openPathField(app);
    for (const k of ["ArrowDown", "ArrowDown", "Space", "Enter", "f", "r", "e", "/"]) {
      await app.keyboard.press(k);
    }
    await app.getByRole("button", { name: "Done" }).focus();
    await app.keyboard.press("ArrowDown");
    await app.keyboard.press("f");
    await app.keyboard.press("r");
    await app.keyboard.press("e");
    await app.keyboard.press("/");
    await expect(foldersModal(app)).toBeVisible();
    await expect(studioShell(app)).toHaveCount(0);
    await expect(searchBox(app)).not.toBeFocused();
    expect(await selectedIndex(app)).toBe(0);
    expect(await playingIndex(app)).toBe(-1);
    expect(api.calls.slice(callsBefore).filter((c) => /\/reveal|\/user/.test(c))).toEqual([]);

    await app.keyboard.press("Escape");
    await expect(foldersModal(app)).toHaveCount(0);
    await expect(foldersButton(app)).toBeFocused();

    // Library shortcuts are live again.
    await app.keyboard.press("ArrowDown");
    expect(await selectedIndex(app)).toBe(1);
  });

  test("L16 Escape from inside the path field also closes the modal", async ({ app }) => {
    await openFolders(app);
    await openPathField(app);
    await app.keyboard.press("Escape");
    await expect(foldersModal(app)).toHaveCount(0);
    await expect(foldersButton(app)).toBeFocused();
  });

  test("L17 Remove root arms on the first click for ~3 s and only a second click acts", async ({
    page,
    api,
    pageErrors,
  }) => {
    void pageErrors;
    await loadWithClock(page);
    await openFolders(page);
    const remove = page.getByRole("button", { name: /^(Confirm )?remove$/i });
    await expect(remove).toHaveText("Remove");

    await remove.click();
    await expect(remove).toHaveText("Confirm remove");
    expect(api.callsTo("DELETE /api/library/roots")).toEqual([]);

    // Still armed just before 3 s, disarmed shortly after (without acting).
    await page.clock.runFor(2400);
    await expect(remove).toHaveText("Confirm remove");
    await page.clock.runFor(900);
    await expect(remove).toHaveText("Remove");
    expect(api.callsTo("DELETE /api/library/roots")).toEqual([]);

    // After a time-out, the next click only arms again.
    await remove.click();
    await expect(remove).toHaveText("Confirm remove");
    expect(api.callsTo("DELETE /api/library/roots")).toEqual([]);

    // The second click acts.
    await remove.click();
    await expect.poll(() => api.callsTo("DELETE /api/library/roots").length).toBe(1);
  });

  test("L17 Rebuild all arms on the first click for ~3 s and only a second click acts", async ({
    page,
    api,
    pageErrors,
  }) => {
    void pageErrors;
    await loadWithClock(page);
    await openFolders(page);
    const rebuild = page.getByRole("button", { name: /^(Confirm rebuild|Rebuild all)$/ });
    const rescans = () => api.callsTo("POST /api/library/rescan").length;
    const before = rescans();

    await rebuild.click();
    await expect(rebuild).toHaveText("Confirm rebuild");
    expect(rescans()).toBe(before);
    await page.clock.runFor(2400);
    await expect(rebuild).toHaveText("Confirm rebuild");
    await page.clock.runFor(900);
    await expect(rebuild).toHaveText("Rebuild all");
    expect(rescans()).toBe(before);

    await rebuild.click();
    await expect(rebuild).toHaveText("Confirm rebuild");
    await rebuild.click();
    await expect.poll(rescans).toBe(before + 1);
    await expect(rebuild).toHaveText("Rebuild all");
  });

  test("L20 Add folder… opens the picker and adds the picked folder", async ({ app, api }) => {
    await openFolders(app);
    await expect(pathField(app)).toHaveCount(0);
    await app.getByRole("button", { name: "Add folder…" }).click();
    await expect.poll(() => api.callsTo("POST /api/library/roots").length).toBe(1);
    expect(api.callsTo("POST /api/library/pick-folder")).toHaveLength(1);
  });

  test("L20 or paste a path reveals an empty, focused field; Enter adds it", async ({
    app,
    api,
  }) => {
    await openFolders(app);
    await openPathField(app);
    await expect(pathField(app)).toHaveValue("");
    await expect(pathField(app)).not.toHaveAttribute("placeholder");
    await app.keyboard.type("D:/SFX/Foley");
    await app.keyboard.press("Enter");
    await expect.poll(() => api.callsTo("POST /api/library/roots").length).toBe(1);
    await expect(pathField(app)).toHaveCount(0);
    await expect(foldersModal(app)).toBeVisible();
  });

  test("L20 Cancel hides the path field and returns focus to its toggle", async ({ app, api }) => {
    await openFolders(app);
    await openPathField(app);
    await app.keyboard.type("D:/half");
    await app.getByRole("button", { name: "Cancel" }).click();
    await expect(pathField(app)).toHaveCount(0);
    await expect(app.getByRole("button", { name: "or paste a path" })).toBeFocused();
    expect(api.callsTo("POST /api/library/roots")).toEqual([]);
  });

  test.describe("while a scan runs", () => {
    test.use({ apiOptions: { indexing: true } });
    test("L17 Remove is disabled while a scan runs", async ({ app, api }) => {
      await openFolders(app);
      const remove = app.getByRole("button", { name: "Remove" });
      await expect(remove).toBeDisabled();
      await remove.click({ force: true });
      await expect(remove).toHaveText("Remove"); // never arms
      expect(api.callsTo("DELETE /api/library/roots")).toEqual([]);
    });
  });
});

test.describe("switches and checkboxes", () => {
  test("L18 Best offset switch is reachable by Tab and toggles with Space and Enter", async ({
    app,
  }) => {
    const sw = app.getByRole("switch", { name: "Best offset" });
    await expect(sw).toBeChecked();
    await tabTo(app, sw);
    await expect(sw).toBeFocused();

    await app.keyboard.press("Space");
    await expect(sw).not.toBeChecked();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await app.keyboard.press("Enter");
    await expect(sw).toBeChecked();
    await expect(sw).toHaveAttribute("aria-checked", "true");

    // Neither key also fired a library shortcut.
    expect(await playingIndex(app)).toBe(-1);
    await expect(inspector(app)).toBeVisible();
  });

  test("L18 Favorites only checkbox is reachable by Tab and toggles with Space and Enter", async ({
    app,
  }) => {
    await app.getByRole("button", { name: /^Filters/ }).click();
    const cb = app.getByRole("checkbox", { name: "Favorites only" });
    await expect(cb).toBeVisible();
    await expect(cb).not.toBeChecked();
    await app.getByRole("button", { name: /^Filters/ }).blur();
    await tabTo(app, cb);
    await expect(cb).toBeFocused();

    await app.keyboard.press("Space");
    await expect(cb).toBeChecked();
    await expect(cb).toHaveAttribute("aria-checked", "true");
    await app.keyboard.press("Enter");
    await expect(cb).not.toBeChecked();
    await expect(inspector(app)).toBeVisible();
    expect(await playingIndex(app)).toBe(-1);
  });
});

test.describe("transient footer messages", () => {
  test.describe("reveal fails", () => {
    test.use({ apiOptions: { failReveal: true } });
    test("L19 a footer error clears after ~5 s", async ({ page, api, pageErrors }) => {
      void pageErrors;
      await loadWithClock(page);
      await page.keyboard.press("r");
      await expect.poll(() => api.callsTo("POST /api/files/f0/reveal").length).toBe(1);
      await expect(statusbar(page)).toContainText("Reveal failed");

      await page.clock.runFor(4000);
      await expect(statusbar(page)).toContainText("Reveal failed");
      await page.clock.runFor(1500);
      await expect(statusbar(page)).not.toContainText("Reveal failed");
      await expect(statusbar(page)).toContainText(/Showing \d+ of \d+ sounds/);
    });
  });

  test("L19 the Similar-to label is not transient", async ({ page, api, pageErrors }) => {
    void api;
    void pageErrors;
    await loadWithClock(page);
    await row(page, 0).getByRole("button", { name: "Find similar sounds" }).click();
    await expect(statusbar(page)).toContainText("Similar to snd0.wav");
    await page.clock.runFor(12_000);
    await expect(statusbar(page)).toContainText("Similar to snd0.wav");
    await expect(page.getByRole("button", { name: "Exit similarity view" })).toBeVisible();
  });
});
