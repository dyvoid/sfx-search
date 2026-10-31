// UX rules (DESIGN.md "UX Rules"): first-run screen shows the true state, and
// the library screen carries only controls that work in the current state.
import type { Page } from "@playwright/test";
import { expect, flushApi, foldersModal, row, statusbar, test } from "./fixtures";

const searchBox = (page: Page) => page.getByLabel("Search sounds");
const heading = (page: Page, name: string) => page.getByRole("heading", { name });

async function loadFirstRun(page: Page): Promise<void> {
  await page.goto("/");
}

test.describe("first run: no folders", () => {
  test.use({ apiOptions: { total: 0, roots: [] } });

  test("shows only the app name and Folders; the setup is the whole screen", async ({
    page,
    api,
    pageErrors,
  }) => {
    void api;
    void pageErrors;
    await loadFirstRun(page);
    await expect(heading(page, "Add your sound-effects folders")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add folder…" })).toBeVisible();

    await expect(searchBox(page)).toHaveCount(0);
    for (const name of [/^Search$/, /^Filters/, /Match audio/, /Edit Audio/, /Repeat/]) {
      await expect(page.getByRole("button", { name })).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: "Sort order" })).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /density/ })).toHaveCount(0);
    await expect(page.locator(".sfx-transport-strip")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Folders/ })).toBeVisible();

    // No key-hint footer, no eyebrow label, no stray status text.
    await expect(page.locator(".sfx-statusbar")).toHaveCount(0);
    await expect(page.getByText("Library setup")).toHaveCount(0);
    await expect(page.getByText(/decoded and embedded/i)).toHaveCount(0);
  });
});

test.describe("first run: scanning", () => {
  test.use({
    apiOptions: { total: 0, roots: ["/lib"], indexing: true, scanDone: 3 },
  });

  test("shows one progress block and no duplicate banner, badge or footer text", async ({
    page,
    api,
    pageErrors,
  }) => {
    void api;
    void pageErrors;
    await loadFirstRun(page);
    await expect(heading(page, "Scanning your folders")).toBeVisible();
    await expect(page.getByText("3 of 10 files")).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Scan progress" })).toHaveAttribute(
      "aria-valuenow",
      "30"
    );

    await expect(page.locator(".sfx-index-banner")).toHaveCount(0);
    await expect(page.getByText("Scanning", { exact: true })).toHaveCount(0);
    await expect(page.locator(".sfx-statusbar")).toHaveCount(0);
    await expect(searchBox(page)).toHaveCount(0);
    // Adding another folder is available but not the primary action.
    await expect(page.getByRole("button", { name: "Add folder…" })).toHaveClass(
      /ds-btn-secondary/
    );
    await expect(page.getByText("/lib", { exact: true })).toBeVisible();
  });
});

test.describe("first run: scan failed", () => {
  const detail = "Could not read /lib/Broken\n  File \"indexer.py\", line 12\nOSError: boom";
  test.use({
    apiOptions: { total: 0, roots: ["/lib"], indexingError: detail },
  });

  test("shows the error, collapsible details and Try again", async ({
    page,
    api,
    pageErrors,
  }) => {
    void pageErrors;
    await loadFirstRun(page);
    await expect(heading(page, "Scanning stopped")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveText("Could not read /lib/Broken");
    const details = page.locator("details.sfx-setup-details");
    await expect(details).not.toHaveAttribute("open");
    await details.locator("summary").click();
    await expect(details.locator("pre")).toContainText("OSError: boom");
    await expect(searchBox(page)).toHaveCount(0);

    const before = api.callsTo("POST /api/library/rescan").length;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => api.callsTo("POST /api/library/rescan").length).toBe(before + 1);
  });
});

test.describe("first run: folders without audio", () => {
  test.use({ apiOptions: { total: 0, roots: ["/lib/Empty"] } });

  test("says no audio files were found and lists the folders", async ({
    page,
    api,
    pageErrors,
  }) => {
    void api;
    void pageErrors;
    await loadFirstRun(page);
    await expect(heading(page, "No audio files found")).toBeVisible();
    await expect(page.getByText("/lib/Empty", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add folder…" })).toBeVisible();
    await expect(searchBox(page)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /Scanning/ })).toHaveCount(0);
  });
});

test.describe("library top bar", () => {
  test("search box has a plain placeholder and no syntax chips", async ({ app, pageErrors }) => {
    void pageErrors;
    await expect(searchBox(app)).toHaveAttribute("placeholder", "Search sounds");
    await searchBox(app).focus();
    await expect(app.getByText(/quick syntax/i)).toHaveCount(0);
    await expect(app.locator(".ds-menu")).toHaveCount(0);
  });

  test("no Edit Audio button; playback options use plain names", async ({ app, pageErrors }) => {
    void pageErrors;
    await expect(app.getByRole("button", { name: "Edit Audio", exact: true })).toHaveCount(0);
    await expect(app.getByRole("switch", { name: "Play from best match" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Repeat" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Loop", exact: true })).toHaveCount(0);
  });

  test("time readout and meter appear only while audio plays", async ({ app, pageErrors }) => {
    void pageErrors;
    await expect(app.locator(".sfx-readout-val")).toHaveCount(0);
    await app.keyboard.press("Space");
    await expect(app.locator(".sfx-readout-val")).toBeVisible();
    await app.keyboard.press("Space");
    await expect(app.locator(".sfx-readout-val")).toHaveCount(0);
  });

  test("no column header row", async ({ app, pageErrors }) => {
    void pageErrors;
    await expect(app.locator(".sfx-list-head")).toHaveCount(0);
    await expect(app.getByRole("columnheader")).toHaveCount(0);
  });

  test("inspector has no text label in its header", async ({ app, pageErrors }) => {
    void pageErrors;
    await expect(app.getByRole("button", { name: "Collapse inspector" })).toBeVisible();
    await expect(app.locator(".sfx-inspector-head").getByText("Inspector")).toHaveCount(0);
  });

  test("match percentage shows only for a text query", async ({ app, pageErrors }) => {
    void pageErrors;
    await expect(row(app, 0).locator(".sfx-row-score")).toBeEmpty();
    await searchBox(app).fill("door");
    await searchBox(app).press("Enter");
    await expect(row(app, 0).locator(".sfx-row-score")).toHaveText("40%");
  });
});

test.describe("recent searches", () => {
  test("the dropdown opens only when there are recent searches", async ({ app, pageErrors }) => {
    void pageErrors;
    await searchBox(app).focus();
    await expect(app.locator(".ds-menu")).toHaveCount(0);
    await searchBox(app).fill("door");
    await searchBox(app).press("Enter");
    await app.keyboard.press("Escape");
    await searchBox(app).focus();
    await expect(app.locator(".ds-menu")).toContainText("door");
    await expect(app.locator(".ds-menu")).not.toContainText(/syntax/i);
  });
});

test.describe("filters", () => {
  test("apply immediately; Clear filters resets; no fake values or root dropdown", async ({
    app,
    api,
    pageErrors,
  }) => {
    void pageErrors;
    await app.getByRole("button", { name: /^Filters/ }).click();
    await expect(app.getByRole("button", { name: "Apply" })).toHaveCount(0);
    await expect(app.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
    await expect(app.getByText("Folder root")).toHaveCount(0);
    await expect(app.getByText("Min loop score")).toHaveCount(0);
    for (const label of ["Minimum loudness", "Maximum loudness"]) {
      await expect(app.getByRole("spinbutton", { name: label })).toHaveAttribute(
        "placeholder",
        /^(Min|Max)$/
      );
    }

    const searches = () => api.callsTo("POST /api/search").length;
    let before = searches();
    await app.getByRole("checkbox", { name: "Loopable only" }).click();
    await expect.poll(searches).toBe(before + 1);
    await expect(app.getByRole("button", { name: "Clear filters" })).toBeVisible();

    // Typed numbers are debounced into one search.
    before = searches();
    await app.getByRole("spinbutton", { name: "Minimum duration" }).pressSequentially("12");
    await expect.poll(searches).toBe(before + 1);
    await flushApi(app);
    expect(searches()).toBe(before + 1);

    await app.getByRole("button", { name: "Clear filters" }).click();
    await expect(app.getByRole("checkbox", { name: "Loopable only" })).not.toBeChecked();
    await expect(app.getByRole("spinbutton", { name: "Minimum duration" })).toHaveValue("");
    await expect(app.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
  });
});

test.describe("similar sounds view", () => {
  test("shows a chip in the search bar; clearing it restores the previous query", async ({
    app,
    pageErrors,
  }) => {
    void pageErrors;
    await searchBox(app).fill("door");
    await searchBox(app).press("Enter");
    await app.keyboard.press("Escape");
    await row(app, 2).getByRole("button", { name: "Find similar sounds" }).click();

    const chip = app.locator(".sfx-similar-chip");
    await expect(chip).toContainText("Similar to snd2.wav");
    await expect(searchBox(app)).toHaveValue("");
    await expect(statusbar(app)).not.toContainText("Similar to");
    await expect(row(app, 0).locator(".sfx-row-score")).toHaveText("40%");

    await app.getByRole("button", { name: "Exit similarity view" }).click();
    await expect(chip).toHaveCount(0);
    await expect(searchBox(app)).toHaveValue("door");
    await expect(app.locator(".sfx-row")).toHaveCount(50);
  });
});

test.describe("missing folder banner", () => {
  test.use({ apiOptions: { missingRoots: ["/lib"] } });
  test("uses the same names as the Folders dialog", async ({ app, pageErrors }) => {
    void pageErrors;
    await expect(app.getByRole("button", { name: "Scan for changes" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Rescan" })).toHaveCount(0);
  });
});

test.describe("scan in progress with sounds", () => {
  test.use({ apiOptions: { indexing: true } });
  test("progress banner doesn't repeat the top bar's Folders button", async ({
    app,
    pageErrors,
  }) => {
    void pageErrors;
    const banner = app.locator(".sfx-index-banner");
    await expect(banner).toBeVisible();
    await expect(banner.getByRole("button")).toHaveCount(0);
    await expect(app.getByRole("button", { name: /^Folders/ })).toBeVisible();
  });
});

test.describe("library: scan failed with sounds indexed", () => {
  test.use({ apiOptions: { indexingError: "CUDA error: no kernel image\nstack line" } });

  test("shows the first error line with Try again", async ({ app, api }) => {
    const banner = app.getByRole("alert").filter({ hasText: "Scanning stopped" });
    await expect(banner).toContainText("CUDA error: no kernel image");
    await expect(banner).not.toContainText("stack line");
    await banner.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => api.callsTo("POST /api/library/rescan").length).toBe(1);
  });
});

test.describe("startup: backend not answering yet", () => {
  test.use({ apiOptions: { libraryFailures: 3 } });

  test("keeps asking, says it is starting, and shows the library once it answers", async ({
    page,
    api,
    pageErrors,
  }) => {
    void api;
    void pageErrors;
    await page.goto("/");
    await expect(page.getByRole("status").getByText("Starting up")).toBeVisible();
    await expect(row(page, 0)).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText("Starting up")).toHaveCount(0);
  });
});

test.describe("startup: backend down", () => {
  test.use({ apiOptions: { libraryFailures: 1000 } });

  test("explains the wait after a few failed attempts", async ({ page, api, pageErrors }) => {
    void api;
    void pageErrors;
    await page.goto("/");
    await expect(page.getByText("Waiting for the search backend")).toBeVisible({
      timeout: 10_000,
    });
  });
});

test("the folder panel opens the same Folders dialog as the top bar", async ({ app }) => {
  const manage = app.locator(".sfx-folder-pane").getByRole("button", { name: "Manage folders" });
  await expect(manage).toBeVisible();
  await manage.click();
  await expect(foldersModal(app)).toBeVisible();
});
