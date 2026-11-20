// Studio edit page: the transport's Loop toggle, rule P8.
// Spec: docs/testing/keyboard-contract.md
import type { Page } from "@playwright/test";
import { expect, openStudio, studioFront, studioPlayButton, test } from "./fixtures";

const loopToggle = (page: Page) =>
  studioFront(page).getByRole("button", { name: "Loop", exact: true });

test.describe("Studio edit page, Loop toggle", () => {
  test.use({ apiOptions: { audioSeconds: 1 } });

  test.beforeEach(async ({ app }) => {
    await openStudio(app);
  });

  test("P8 with Loop on, preview repeats past the end of the sound", async ({ app }) => {
    await loopToggle(app).click();
    await expect(loopToggle(app)).toHaveAttribute("aria-pressed", "true");
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
    await app.waitForTimeout(1800);
    await expect(studioPlayButton(app)).toHaveClass(/playing/);

    // Switching it off while playing lets it run out and stop.
    await loopToggle(app).click();
    await expect(studioPlayButton(app)).not.toHaveClass(/playing/, { timeout: 3000 });
  });

  test("P8 without Loop, preview stops at the end", async ({ app }) => {
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
    await expect(studioPlayButton(app)).not.toHaveClass(/playing/, { timeout: 3000 });
  });

  test("P8 each edit module keeps its own Loop setting", async ({ app }) => {
    await loopToggle(app).click();
    await app.keyboard.press("Digit2");
    await expect(loopToggle(app)).toHaveAttribute("aria-pressed", "false");
    await app.keyboard.press("Digit1");
    await expect(loopToggle(app)).toHaveAttribute("aria-pressed", "true");
  });

  test("P8 the Loop page's File preview does not loop", async ({ app }) => {
    await loopToggle(app).click();
    await app.keyboard.press("Digit3");
    await studioFront(app).getByRole("button", { name: "File", exact: true }).click();
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
    await expect(studioPlayButton(app)).not.toHaveClass(/playing/, { timeout: 3000 });
  });
});
