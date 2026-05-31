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

test("top controls stay visible after scrolling the dashboard", async ({ page }) => {
  await page.goto("/?tab=dashboard");

  const controls = page.getByRole("heading", { name: "Usage dashboard" });
  await expect(controls).toBeVisible({ timeout: 20_000 });

  await page.evaluate(() => {
    const scroller = document.querySelector(".relative.h-full.overflow-y-auto") as HTMLElement | null;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  await expect(controls).toBeVisible();
  const scrolledBox = await controls.boundingBox();
  expect(scrolledBox).not.toBeNull();
  expect(scrolledBox!.y).toBeLessThan(200);
});

// Skipped: the pricing rows are rendered grouped by provider, so toggling
// model_asc <-> model_desc only reorders *within* each provider group and the
// first visible row (top of the first provider section) often stays the same.
// Needs a richer fixture or a per-group assertion. Tracked separately.
test.skip("model rate sort reorders the visible list", async ({ page }) => {
  await page.goto("/?tab=dashboard");

  const pricingSection = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Pricing source and assumptions" }) })
    .first();
  await expect(pricingSection).toBeVisible({ timeout: 20_000 });

  const modelSort = pricingSection.locator("select").nth(2);
  const rowList = pricingSection.locator(".max-h-72.overflow-auto").first();

  // Reordering only changes the head element when at least two distinct model
  // rows are loaded. The mock e2e fixture seeds a single model, so on the bare
  // CI dataset there is nothing to reorder; skip rather than assert a flake.
  const rowCount = await rowList.locator("span.truncate").count();
  test.skip(rowCount < 2, `Need >=2 model rate rows to verify reordering, got ${rowCount}`);

  const firstModelText = async (): Promise<string> => {
    const handle = rowList.locator("span.truncate").first();
    await handle.waitFor({ state: "visible" });
    return (await handle.textContent())?.trim() ?? "";
  };

  await modelSort.selectOption("model_asc");
  const ascFirst = await firstModelText();

  await modelSort.selectOption("model_desc");
  await expect
    .poll(async () => await firstModelText(), { timeout: 5_000 })
    .not.toBe(ascFirst);
});

test("functionality filter narrows the model rate list", async ({ page }) => {
  await page.goto("/?tab=dashboard");

  const pricingSection = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Pricing source and assumptions" }) })
    .first();
  await expect(pricingSection).toBeVisible({ timeout: 20_000 });

  const functionSelect = pricingSection.locator("select").nth(1);
  const options = functionSelect.locator("option");
  const optionCount = await options.count();

  let chosen: string | null = null;
  for (let i = 0; i < optionCount; i++) {
    const value = await options.nth(i).getAttribute("value");
    if (value && value !== "all") {
      chosen = value;
      break;
    }
  }
  test.skip(!chosen, "No functionality buckets present in mock data");

  await functionSelect.selectOption(chosen!);

  const rowList = pricingSection.locator(".max-h-72.overflow-auto").first();
  await expect(rowList).toBeVisible();

  const empty = rowList.getByText("No model rates match the selected filters.");
  const isEmpty = await empty.isVisible().catch(() => false);
  if (!isEmpty) {
    const matchingLabels = rowList.locator(`span:has-text("${chosen}")`);
    expect(await matchingLabels.count()).toBeGreaterThan(0);
  }
});

test("manual currency selection persists across reloads", async ({ page }) => {
  await page.goto("/?tab=dashboard");

  await expect(page.getByRole("heading", { name: "Usage dashboard" })).toBeVisible({ timeout: 20_000 });

  // The currency mode toggle is a pair of buttons (Auto / Manual), not a
  // <select>. Selecting Manual reveals the currency-code <select> next to it.
  await page.getByRole("button", { name: "Manual", exact: true }).click();

  const currencySelect = page.locator("select").filter({ has: page.locator("option[value='EUR']") }).first();
  await expect(currencySelect).toBeVisible();
  await currencySelect.selectOption("EUR");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Usage dashboard" })).toBeVisible({ timeout: 20_000 });

  // Persisted: Manual button stays active, EUR remains selected.
  await expect(page.getByRole("button", { name: "Manual", exact: true })).toHaveClass(/bg-\[var\(--accent\)\]/);
  const reloadedSelect = page.locator("select").filter({ has: page.locator("option[value='EUR']") }).first();
  await expect(reloadedSelect).toHaveValue("EUR");
});
