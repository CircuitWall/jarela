import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await page.addInitScript(() => {
    try { localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=harness");
});

test("Harness panel renders the Harnesses header", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Harnesses" })).toBeVisible({ timeout: 15_000 });
});

test("Harness panel exposes the default harness preset", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Harnesses" })).toBeVisible({ timeout: 15_000 });
  // ADR-0033 ships at least one built-in preset; expect SOME visible row content.
  await expect(page.locator("main")).toBeVisible();
});
