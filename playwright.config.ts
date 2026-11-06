import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveE2EServers } from "./scripts/e2e-servers.mjs";

// Each worker slot uses its own server and database. A replacement worker
// retains the same parallelIndex, so retries keep the same isolated server.
const { external, urls, workers } = resolveE2EServers(process.env);

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  // Keep each spec's tests in order; independent files may use different
  // worker slots, each with a separate server and SQLite database.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
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
      // Keep mobile coverage focused on viewport/PWA-sensitive contracts.
      // The full workflow suite runs once in Chromium; duplicating API-only
      // CRUD and desktop-neutral panel checks here adds time without a second
      // browser-specific signal.
      name: "mobile-safari",
      use: { ...devices["iPhone 13"] },
      testMatch: [
        "**/smoke.spec.ts",
        "**/layout.spec.ts",
        "**/chat-mock.spec.ts",
        "**/panel-chat-focus-boundary.spec.ts",
      ],
    },
  ],

  webServer: external
    ? undefined
    : urls.map((url) => {
      const dbDir = mkdtempSync(join(tmpdir(), "jarela-e2e-"));
      return {
        // Run against the production build so what CI tests matches what
        // ships. `npm run build` must have run before invoking this config.
        command: "npm start",
        url,
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
          JARELA_DB_DIR: dbDir,
          // Authoring acceptance installs drop-ins; never inherit a developer's
          // configured autoload directory from .env.local.
          JARELA_TOOLS_DIR: join(dbDir, "tools"),
          // Non-default port so we never collide with an installed
          // jarela on 4312.
          JARELA_PORT: new URL(url).port,
          JARELA_HOSTNAME: "127.0.0.1",
          // Speed up the scheduler tick so the watcher → reindex e2e
          // doesn't spend 30 s waiting for the next tick. 250 ms is
          // tight enough that "save → search" feels live in the test
          // but still leaves debounce + indexing room.
          JARELA_SCHEDULER_TICK_MS: "250",
        },
      };
    }),
});
