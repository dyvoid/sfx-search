// Save / Download dialog: output format choice (WAV, FLAC, MP3, OGG, Opus).
import type { Page } from "@playwright/test";
import {
  downloadButton,
  downloadDialog,
  expect,
  openStudio,
  saveCalls,
  saveDialog,
  test,
} from "./fixtures";

const pill = (dialog: ReturnType<typeof saveDialog>, group: string, name: string) =>
  dialog.getByRole("group", { name: group }).getByRole("button", { name, exact: true });

async function clearStoredFormat(page: Page): Promise<void> {
  await page.evaluate(() => window.localStorage.removeItem("sfx.studio.outputSpec"));
}

test("choosing a format updates the filename and is sent with the save", async ({ app, api }) => {
  await clearStoredFormat(app);
  await openStudio(app);
  await app.getByRole("button", { name: "Save to Library" }).click();
  const dlg = saveDialog(app);
  const name = dlg.getByLabel("Filename");
  await expect(name).toHaveValue(/\.wav$/);
  await expect(pill(dlg, "Bit depth", "24-bit")).toHaveAttribute("aria-pressed", "true");

  await pill(dlg, "Format", "FLAC").click();
  await expect(name).toHaveValue(/\.flac$/);
  await pill(dlg, "Format", "MP3").click();
  await expect(name).toHaveValue(/\.mp3$/);
  await expect(dlg.getByRole("group", { name: "Bit depth" })).toHaveCount(0);
  await pill(dlg, "Bitrate", "320").click();

  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dlg).toHaveCount(0);
  const calls = saveCalls(api);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("format=mp3");
  expect(calls[0]).toContain("bitrate=320");
});

test("Download opens a dialog and downloads in the chosen format", async ({ app, api }) => {
  await clearStoredFormat(app);
  await openStudio(app);
  await downloadButton(app).click();
  const dlg = downloadDialog(app);
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("checkbox")).toHaveCount(0); // no "replace" on a download

  await pill(dlg, "Format", "FLAC").click();
  await dlg.getByLabel("Filename").fill("my take");
  const download = app.waitForEvent("download");
  await dlg.getByRole("button", { name: "Download", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("my take.flac");
  await expect(dlg).toHaveCount(0);
  expect(api.callsTo("POST /api/transcode")).toHaveLength(1);
});

test("the chosen format is remembered for the next dialog", async ({ app }) => {
  await clearStoredFormat(app);
  await openStudio(app);
  await downloadButton(app).click();
  await pill(downloadDialog(app), "Format", "OGG").click();
  await app.keyboard.press("Escape");
  await expect(downloadDialog(app)).toHaveCount(0);

  await app.getByRole("button", { name: "Save to Library" }).click();
  await expect(pill(saveDialog(app), "Format", "OGG")).toHaveAttribute("aria-pressed", "true");
  await expect(saveDialog(app).getByLabel("Filename")).toHaveValue(/\.ogg$/);
});
