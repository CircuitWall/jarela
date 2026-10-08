import { test, expect } from "@playwright/test";
import { dismissOverlayBanners, seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await dismissOverlayBanners(page);
  await page.goto("/?tab=models");
});

test("Models panel header + seeded model row render", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible({ timeout: 15_000 });
  // Target the row: the Embeddings select also lists model names in hidden options.
  await expect(page.locator('[data-deep-link-id="e2e-mock"]')).toBeVisible();
});

test("Models panel exposes an Add affordance", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "New" })).toBeVisible();
});
