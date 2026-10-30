import { test, expect, openStudio, studioPlayButton } from "./fixtures";

test.describe("Studio, Seamless Loop candidates", () => {
  test.use({ apiOptions: { audioSeconds: 6 } });

  test("switching to a candidate outside the playing loop keeps looping", async ({ app }) => {
    await openStudio(app);
    await app.keyboard.press("Digit3");
    await app.keyboard.press("f");
    const chips = app.locator(".sfx-candidate-chip");
    await expect(chips.nth(1)).toBeVisible({ timeout: 15_000 });

    // Play the latest-starting candidate, then pick the earliest-starting one,
    // whose start lies before the region that is playing.
    await chips.last().click();
    await studioPlayButton(app).click();
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
    await app.waitForTimeout(500);
    await chips.first().click();

    // Falling back to file playback would run to the end (~5.6 s) and stop.
    await app.waitForTimeout(6_500);
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
  });
});
