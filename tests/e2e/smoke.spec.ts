import { test, expect } from "@playwright/test";
import { seedMockAgent, waitForAppReady } from "./helpers";

test.beforeEach(async ({ request }) => {
  await seedMockAgent(request);
});

test("app shell renders without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");

  // The composer textarea is the canonical "the app booted into chat" signal.
  await expect(page.getByPlaceholder("Message…")).toBeVisible({ timeout: 15_000 });

  // Ignore a few well-known browser noise sources that are not regressions.
  // - favicon / manifest / service-worker chatter on first paint.
  // - Mobile Safari logs `Viewport argument key "interactive-widget" not
  //   recognized` because it doesn't implement that meta key yet — that's
  //   intentional (the JS visualViewport hook is the Safari fallback).
  const filtered = errors.filter((e) =>
    !/favicon|manifest|service.?worker|workbox/i.test(e) &&
    !/Viewport argument key "interactive-widget"/i.test(e),
  );
  expect(filtered, `unexpected console/page errors: ${filtered.join(" | ")}`).toEqual([]);
});

test("health endpoint responds", async ({ request }) => {
  const r = await request.get("/api/v1/health");
  expect(r.ok()).toBeTruthy();
});

test("a pending health check does not block the boot picker", async ({ page }) => {
  let releaseHealth!: () => void;
  const healthReady = new Promise<void>((resolve) => { releaseHealth = resolve; });
  await page.route("**/api/v1/health", async (route) => {
    await healthReady;
    await route.continue();
  });

  try {
    await page.goto("/");
    const boot = page.getByTestId("boot-screen");
    await expect(boot).toBeVisible();
    await expect(boot.getByRole("button", { name: "Open E2E Mock" })).toBeVisible();
    await expect(page.getByText("Launching Jarela", { exact: true })).toHaveCount(0);
    await expect(page.locator('[role="status"][aria-live="polite"].fixed.inset-0')).toHaveCount(1);
    const ready = waitForAppReady(page);
    releaseHealth();
    await ready;
    await expect(page.getByPlaceholder("Message…")).toBeEnabled();
  } finally {
    releaseHealth();
  }
});
