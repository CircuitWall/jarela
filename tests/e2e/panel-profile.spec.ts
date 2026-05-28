import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await page.addInitScript(() => {
    try { localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1"); } catch { /* sandbox */ }
  });
  await page.goto("/?tab=profile");
});

test("Profile panel renders the User Profile header", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "User Profile" })).toBeVisible({ timeout: 15_000 });
});

test("Profile panel mounts the edit affordances", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "User Profile" })).toBeVisible({ timeout: 15_000 });
  // Profile is form-driven — at least one input or textarea should be present.
  const inputs = page.locator("main input, main textarea");
  await expect(inputs.first()).toBeVisible();
});
