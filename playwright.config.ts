import { defineConfig, devices } from "@playwright/test";

// Where the dev/prod server lives. Override JARELA_E2E_BASE_URL to point
// at an already-running server (skips the webServer block below).
const baseURL = process.env.JARELA_E2E_BASE_URL ?? "http://127.0.0.1:4312";
const reuseServer = !!process.env.JARELA_E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Catches iOS PWA layout regressions (e.g. position:absolute drifting
      // when the on-screen keyboard pushes the body up).
      name: "mobile-safari",
      use: { ...devices["iPhone 13"] },
    },
  ],

  webServer: reuseServer
    ? undefined
    : {
        // Run against the production build so what CI tests matches what
        // ships. `npm run build` must have run before invoking this config.
        command: "npm start",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          // Opt-in deterministic provider so chat tests don't need real
          // API keys. See lib/providers/mock.ts.
          JARELA_ENABLE_MOCK_PROVIDER: "1",
          // Silence the daily npm/GitHub probe during tests.
          JARELA_DISABLE_UPDATE_CHECK: "1",
        },
      },
});
