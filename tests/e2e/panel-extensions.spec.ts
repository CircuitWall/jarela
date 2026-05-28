import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await page.addInitScript(() => {
    try { localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=extensions");
});

test("Extensions panel renders the header", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Extensions" })).toBeVisible({ timeout: 15_000 });
});
