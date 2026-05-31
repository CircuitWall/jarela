import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

test.beforeEach(async ({ request }) => {
  await seedMockAgent(request);
});

test("dashboard sort dropdowns are populated", async ({ page }) => {
  await page.goto("/?tab=dashboard");

  await expect(page.getByRole("heading", { name: "Favorite tools" })).toBeVisible({ timeout: 20_000 });

  const favoriteToolsSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Favorite tools" }) }).first();
  const toolSort = favoriteToolsSection.locator("select").first();
  await expect(toolSort).toBeVisible();
  await expect(toolSort.locator("option")).toHaveCount(5);
  await expect(toolSort.locator("option", { hasText: "Sort: best first" })).toHaveCount(1);
  await expect(toolSort.locator("option", { hasText: "Sort: most calls" })).toHaveCount(1);
  await expect(toolSort.locator("option", { hasText: "Sort: most errors" })).toHaveCount(1);
  await expect(toolSort.locator("option", { hasText: "Sort: highest error rate" })).toHaveCount(1);
  await expect(toolSort.locator("option", { hasText: "Sort: name A->Z" })).toHaveCount(1);

  const pricingSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Pricing source and assumptions" }) }).first();
  await expect(pricingSection).toBeVisible();

  const pricingSelects = pricingSection.locator("select");
  await expect(pricingSelects).toHaveCount(3);

  const vendorSelect = pricingSelects.nth(0);
  const functionSelect = pricingSelects.nth(1);
  const modelSort = pricingSelects.nth(2);

  await expect(vendorSelect.locator("option", { hasText: "All vendors" })).toHaveCount(1);
  await expect(functionSelect.locator("option", { hasText: "All functions" })).toHaveCount(1);
  await expect(modelSort.locator("option")).toHaveCount(8);
  await expect(modelSort.locator("option", { hasText: "Sort: model A->Z" })).toHaveCount(1);
  await expect(modelSort.locator("option", { hasText: "Sort: model Z->A" })).toHaveCount(1);
  await expect(modelSort.locator("option", { hasText: "Sort: highest input rate" })).toHaveCount(1);
  await expect(modelSort.locator("option", { hasText: "Sort: lowest input rate" })).toHaveCount(1);
  await expect(modelSort.locator("option", { hasText: "Sort: highest output rate" })).toHaveCount(1);
  await expect(modelSort.locator("option", { hasText: "Sort: lowest output rate" })).toHaveCount(1);
  await expect(modelSort.locator("option", { hasText: "Sort: confidence" })).toHaveCount(1);
  await expect(modelSort.locator("option", { hasText: "Sort: lowest confidence" })).toHaveCount(1);
});
