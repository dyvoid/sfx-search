import { expect, openStudio, row, selectedIndex, studioShell, test } from "./fixtures";

test("library loads results from the mocked API", async ({ app, api }) => {
  await expect(row(app, 0)).toContainText("snd0.wav");
  expect(api.callsTo("POST /api/search").length).toBeGreaterThan(0);
  expect(await selectedIndex(app)).toBe(0);
});

test("studio opens and decodes the selected file", async ({ app }) => {
  await openStudio(app);
  await expect(studioShell(app)).toBeVisible();
});
