import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

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
