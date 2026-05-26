import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// E2E runs against a fully isolated server: a non-default port (so we
// never collide with a `jarela` instance the developer has installed as
// a system task on the canonical 4312) plus a throwaway DB dir. Setting
// JARELA_E2E_BASE_URL points the runner at a pre-existing server you
// manage yourself — skipping the webServer block entirely.
const E2E_PORT = Number(process.env.JARELA_E2E_PORT ?? 14312);
const defaultBaseURL = `http://127.0.0.1:${E2E_PORT}`;
const baseURL = process.env.JARELA_E2E_BASE_URL ?? defaultBaseURL;
const reuseServer = !!process.env.JARELA_E2E_BASE_URL;

// Each `playwright test` invocation gets its own tmpdir so concurrent
// runs (and the developer's real ~/.jarela) never share state.
const E2E_DB_DIR = reuseServer
  ? undefined
  : mkdtempSync(join(tmpdir(), "jarela-e2e-"));

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
        // Hard `false` even locally — reusing whatever's on the test port
        // would silently let a stale build (or, worse, a user's installed
        // instance on a colliding port) answer the tests with old code
        // and write to their real DB. Always boot fresh.
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          // Opt-in deterministic provider so chat tests don't need real
          // API keys. See lib/providers/mock.ts.
          JARELA_ENABLE_MOCK_PROVIDER: "1",
          // Silence the daily npm/GitHub probe during tests.
          JARELA_DISABLE_UPDATE_CHECK: "1",
          // Throwaway DB so tests never touch the developer's ~/.jarela.
          JARELA_DB_DIR: E2E_DB_DIR!,
          // Non-default port so we never collide with an installed
          // jarela on 4312.
          JARELA_PORT: String(E2E_PORT),
          // Speed up the scheduler tick so the watcher → reindex e2e
          // doesn't spend 30 s waiting for the next tick. 250 ms is
          // tight enough that "save → search" feels live in the test
          // but still leaves debounce + indexing room.
          JARELA_SCHEDULER_TICK_MS: "250",
        },
      },
});
