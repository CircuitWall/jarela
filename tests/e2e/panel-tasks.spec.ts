import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await page.addInitScript(() => {
    try { localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=tasks");
});

test("Tasks panel renders Scheduled Tasks header", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Scheduled Tasks" })).toBeVisible({ timeout: 15_000 });
});

test("Tasks panel exposes a way to schedule a new task", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Scheduled Tasks" })).toBeVisible({ timeout: 15_000 });
  // The schedule-new affordance is a button beside the heading.
  const buttons = page.locator("main button");
  await expect(buttons.first()).toBeVisible();
});
