import { defineConfig, devices } from "@playwright/test";

// E2E harness: drives the real web app against a Vite dev server with every
// /api/* call mocked in e2e/fixtures.ts, so no backend, GPU or library is needed.
const PORT = Number(process.env.E2E_PORT ?? 5175);

export default defineConfig({
  testDir: "./e2e",
  // Concurrent runs (e.g. several agents) must not share an output dir: each
  // run wipes it at start, which breaks the other run's traces with ENOENT.
  outputDir: process.env.E2E_OUTPUT_DIR ?? "test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1400, height: 900 },
        // Optional: point at a preinstalled browser instead of `playwright install`.
        launchOptions: process.env.PW_CHROMIUM_PATH
          ? { executablePath: process.env.PW_CHROMIUM_PATH }
          : {},
      },
    },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
