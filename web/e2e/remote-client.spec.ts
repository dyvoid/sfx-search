// Remote (LAN) client: host-machine-only controls are hidden. Rule L21.
// Spec: docs/testing/keyboard-contract.md
import { expect, foldersModal, inspector, openStudio, row, test } from "./fixtures";

const foldersButton = (page: import("@playwright/test").Page) =>
  page.locator(".sfx-command-actions").getByRole("button", { name: /^Folders/ });

test.describe("LAN client", () => {
  test.use({ apiOptions: { isLocal: false } });

  test("L21 R does nothing and reveal/copy-path controls are not rendered", async ({
    app,
    api,
  }) => {
    await expect(row(app, 0)).toBeVisible();
    await expect(row(app, 0).getByRole("button", { name: "Find similar sounds" })).toBeVisible();
    await expect(
      row(app, 0).getByRole("button", { name: "Reveal file in Explorer" })
    ).toHaveCount(0);

    await app.keyboard.press("r");
    await expect(inspector(app)).toBeVisible(); // open by default
    await expect(inspector(app).getByRole("button", { name: "Reveal file in Explorer" })).toHaveCount(0);
    await expect(inspector(app).getByRole("button", { name: "Copy file path" })).toHaveCount(0);
    expect(api.callsTo("POST /api/files/f0/reveal")).toHaveLength(0);
  });

  test("L21 the Folders list is read-only", async ({ app }) => {
    await expect(row(app, 0)).toBeVisible();
    await foldersButton(app).click();
    const dlg = foldersModal(app);
    await expect(dlg).toBeVisible();
    await expect(dlg.getByText("/lib")).toBeVisible();
    await expect(dlg.getByRole("button", { name: /Add folder/ })).toHaveCount(0);
    await expect(dlg.getByRole("button", { name: /Remove/ })).toHaveCount(0);
    await expect(dlg.getByRole("button", { name: /Scan for changes|Rebuild all/ })).toHaveCount(0);
  });

  test("L21 the Studio has no Show in Explorer button", async ({ app }) => {
    await openStudio(app);
    await expect(app.getByRole("button", { name: /Show in Explorer/ })).toHaveCount(0);
  });

  test.describe("nothing set up yet", () => {
    test.use({ apiOptions: { isLocal: false, roots: [], total: 0 } });
    test("L21 first-run screen explains setup happens on the host", async ({
      page,
      api,
      pageErrors,
    }) => {
      void api;
      void pageErrors;
      await page.goto("/");
      await expect(page.getByText(/on the machine that hosts it/)).toBeVisible();
      await expect(page.getByRole("button", { name: /Add folder/ })).toHaveCount(0);
    });
  });
});

test.describe("host machine", () => {
  test("L21 reveal and folder controls are present when is_local is true", async ({ app }) => {
    await expect(row(app, 0).getByRole("button", { name: "Reveal file in Explorer" })).toBeVisible();
  });
});
