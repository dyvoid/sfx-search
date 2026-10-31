// Studio Tone & EQ: keyboard rules S14-S17 and mouse rule P7.
// Spec: docs/testing/keyboard-contract.md
import type { Page } from "@playwright/test";
import {
  expect,
  keydownPrevented,
  openStudio,
  studioFront,
  studioPlayButton,
  test,
} from "./fixtures";

const node = (page: Page, band: string) => page.locator(`[data-band="${band}"]`);
const powerSwitch = (page: Page, name: string) =>
  page.getByRole("switch", { name: `${name} band on` });
const editorTitle = (page: Page) => page.locator(".sfx-eq-editor .ds-panel-title");
const peak = (page: Page) => studioFront(page).locator(".sfx-signal-meters strong").first();
const tab = (page: Page, name: string) => page.getByRole("tab", { name });

async function freqOf(page: Page, band: string): Promise<number> {
  return Number(await node(page, band).getAttribute("aria-valuenow"));
}

/** Type an exact value into a band setting via its click-to-type readout. */
async function typeValue(page: Page, label: string, value: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`^${label}:`) }).click();
  const input = page.getByRole("textbox", { name: label });
  await input.fill(value);
  await input.press("Enter");
}

test.describe("Studio, Tone & EQ", () => {
  test.beforeEach(async ({ app }) => {
    await openStudio(app);
    await app.keyboard.press("Digit2");
    await app.locator(".sfx-eq-module").waitFor();
  });

  test("S14 arrows move a focused node in frequency and gain, PageUp/Down change Q", async ({
    app,
  }) => {
    await node(app, "mid").focus();
    await expect(editorTitle(app)).toHaveText("Mid band");
    const f0 = await freqOf(app, "mid");
    expect(await keydownPrevented(app, { key: "ArrowRight", code: "ArrowRight" })).toBe(true);
    expect(await freqOf(app, "mid")).toBeGreaterThan(f0);
    await app.keyboard.press("ArrowLeft");
    await app.keyboard.press("ArrowLeft");
    expect(await freqOf(app, "mid")).toBeLessThan(f0);

    await app.keyboard.press("ArrowUp");
    await app.keyboard.press("Shift+ArrowUp");
    await expect(node(app, "mid")).toHaveAttribute("aria-valuetext", /\+0\.6 dB, Q 1\.00/);
    await app.keyboard.press("PageUp");
    await expect(node(app, "mid")).toHaveAttribute("aria-valuetext", /Q 1\.12/);
    // Held arrows keep moving (auto-repeat).
    const f1 = await freqOf(app, "mid");
    for (let i = 0; i < 4; i++) await app.keyboard.down("ArrowRight");
    await app.keyboard.up("ArrowRight");
    expect(await freqOf(app, "mid")).toBeGreaterThan(f1 * 1.2);
  });

  test("S14 cut bands take Left/Right only; Up/Down are not handled", async ({ app }) => {
    await node(app, "hp").focus();
    expect(await keydownPrevented(app, { key: "ArrowUp", code: "ArrowUp" })).toBe(false);
    expect(await keydownPrevented(app, { key: "PageUp", code: "PageUp" })).toBe(false);
    const f0 = await freqOf(app, "hp");
    await app.keyboard.press("ArrowRight");
    expect(await freqOf(app, "hp")).toBeGreaterThan(f0);
  });

  test("S15 0 on a focused node resets it, like a double-click", async ({ app }) => {
    await node(app, "low").focus();
    await app.keyboard.press("ArrowUp");
    await app.keyboard.press("ArrowRight");
    await expect(node(app, "low")).toHaveAttribute("aria-valuetext", /\+0\.5 dB/);
    const f = await freqOf(app, "low");
    await app.keyboard.press("Digit0");
    await expect(node(app, "low")).toHaveAttribute("aria-valuetext", /0\.0 dB/);
    expect(await freqOf(app, "low")).toBe(f); // frequency kept

    await node(app, "hp").focus();
    await app.keyboard.press("ArrowRight");
    expect(await freqOf(app, "hp")).not.toBe(80);
    await node(app, "hp").dblclick();
    expect(await freqOf(app, "hp")).toBe(80);
  });

  test("S16 Studio shortcuts still work on a focused node", async ({ app }) => {
    await node(app, "mid").focus();
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).toHaveClass(/playing/);
    await app.keyboard.press("Space");
    await expect(studioPlayButton(app)).not.toHaveClass(/playing/);
    await node(app, "mid").focus();
    await app.keyboard.press("Digit1");
    await expect(tab(app, "Trim & Gain")).toHaveAttribute("aria-selected", "true");
  });

  test("S17 presets menu: arrows move, Escape closes only the menu, Tab closes it", async ({
    app,
  }) => {
    const trigger = app.getByRole("button", { name: "Presets" });
    await trigger.focus();
    await app.keyboard.press("Enter");
    const items = app.getByRole("menuitem");
    await expect(items.first()).toBeFocused();
    await app.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await app.keyboard.press("End");
    await expect(items.last()).toBeFocused();
    await app.keyboard.press("ArrowDown");
    await expect(items.first()).toBeFocused();
    await app.keyboard.press("Escape");
    await expect(app.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(tab(app, "Tone & EQ")).toHaveAttribute("aria-selected", "true");

    await app.keyboard.press("Enter");
    await expect(items.first()).toBeFocused();
    await app.keyboard.press("Tab");
    await expect(app.getByRole("menu")).toHaveCount(0);

    await trigger.focus();
    await app.keyboard.press("Enter");
    await app.keyboard.press("Enter"); // pick De-Rumble
    await expect(app.getByRole("menu")).toHaveCount(0);
    await expect(powerSwitch(app, "High-Pass")).toHaveAttribute("aria-checked", "true");
    expect(await freqOf(app, "hp")).toBe(110);
  });

  test("P7 pills select and switch bands; the global switch bypasses the EQ", async ({
    app,
  }) => {
    await app.getByRole("button", { name: "Select High band" }).click();
    await expect(editorTitle(app)).toHaveText("High band");
    // The power toggle switches the band without selecting it.
    await powerSwitch(app, "Low-Pass").click();
    await expect(powerSwitch(app, "Low-Pass")).toHaveAttribute("aria-checked", "true");
    await expect(node(app, "lp")).toHaveClass(/\bon\b/);
    await expect(editorTitle(app)).toHaveText("High band");
    await powerSwitch(app, "Mid").click();
    await expect(node(app, "mid")).toHaveClass(/\boff\b/);

    const eqSwitch = app.getByRole("switch", { name: "EQ on" });
    await eqSwitch.click();
    await expect(eqSwitch).toHaveAttribute("aria-checked", "false");
  });

  test("P7 the audio follows typed values, a node drag and the band switch", async ({ app }) => {
    // The test tone is a 440 Hz sine: a Mid bell on it changes the peak level.
    const before = await peak(app).textContent();
    await app.getByRole("button", { name: "Select Mid band" }).click();
    await typeValue(app, "Mid frequency", "440");
    expect(await freqOf(app, "mid")).toBe(440);
    await typeValue(app, "Mid gain", "12");
    await expect(peak(app)).not.toHaveText(before ?? "");
    const boosted = Number((await peak(app).textContent())?.replace(/[^\d.-]/g, ""));

    // Drag the node down past 0 dB: the render lands on release at the latest.
    const b = (await node(app, "mid").boundingBox())!;
    await app.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await app.mouse.down();
    await app.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 120, { steps: 6 });
    await app.mouse.up();
    await expect
      .poll(async () => Number((await peak(app).textContent())?.replace(/[^\d.-]/g, "")))
      .toBeLessThan(boosted - 6);
    const cut = await peak(app).textContent();

    await powerSwitch(app, "Mid").click();
    await expect(peak(app)).toHaveText(before ?? "");
    await powerSwitch(app, "Mid").click();
    await expect(peak(app)).toHaveText(cut ?? "");
  });

  test("P7 wheel over a bell node changes its Q", async ({ app }) => {
    const b = (await node(app, "mid").boundingBox())!;
    await app.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await app.mouse.wheel(0, -100);
    await expect(node(app, "mid")).toHaveAttribute("aria-valuetext", /Q 1\.12/);
  });
});
