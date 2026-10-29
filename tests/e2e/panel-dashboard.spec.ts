import { test, expect } from "@playwright/test";
import { enableFullExperienceMode, seedMockAgent } from "./helpers";
import type { DashboardMetrics } from "../../api/types";

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await enableFullExperienceMode(page);
});

for (const width of [1280, 390]) {
  test(`dashboard shows input/output prices and spending at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const day = new Date().toISOString().slice(0, 10);
    const costs = { input_cost_usd: 3, output_cost_usd: 6, unattributed_cost_usd: 0 };
    const dayCosts = { input_cost_usd: 1, output_cost_usd: 4, unattributed_cost_usd: 0 };
    await page.route("**/api/v1/dashboard/currency*", (route) => route.fulfill({
      json: { currency: "USD", rate_from_usd: 1, country_code: null, source: "default", updated_at: `${day}T00:00:00Z` },
    }));
    await page.route("**/api/v1/dashboard/metrics?*", async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      const data: DashboardMetrics = await response.json();
      const model = {
        provider: "synthetic", model_id: "synthetic-model", model_config_name: "Synthetic",
        message_count: 2, input_tokens_est: 1_500_000, output_tokens_est: 750_000,
        estimated_cost_usd: 9, cost_breakdown: costs,
      };
      data.summary = {
        ...data.summary, input_tokens_est: model.input_tokens_est, output_tokens_est: model.output_tokens_est,
        estimated_cost_usd: 9, cost_breakdown: costs,
      };
      data.by_provider = [model];
      data.by_model = [model];
      data.top_agents = [];
      const basePoint = data.series[data.series.length - 1];
      data.series = [{
        ...basePoint, day: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
        input_tokens_est: 1_000_000, output_tokens_est: 250_000, estimated_cost_usd: 4,
        cost_breakdown: { input_cost_usd: 2, output_cost_usd: 2, unattributed_cost_usd: 0 },
      }, {
        ...basePoint, day,
        input_tokens_est: 500_000, output_tokens_est: 500_000,
        estimated_cost_usd: 5, cost_breakdown: dayCosts,
      }];
      data.breakdowns_by_day = {
        [day]: {
          day, summary: data.series[1], top_agents: [],
          by_provider: [{ ...model, cost_breakdown: dayCosts, estimated_cost_usd: 5 }],
          by_model: [{ ...model, cost_breakdown: dayCosts, estimated_cost_usd: 5 }],
        },
      };
      data.pricing.model_rates = [{
        provider: model.provider, model_id: model.model_id,
        input_per_1m_usd: 2, output_per_1m_usd: 8, source: "https://example.com/pricing",
        inferred: false, confidence: "high", ok: true, status: 200, error: null,
      }];
      data.pricing.aggregator_model_rates = [];
      await route.fulfill({ response, json: data });
    });
    await page.goto("/?tab=dashboard");
    await expect(page.getByText(/Input cost:/).first()).toHaveText("Input cost: $3.00");
    await expect(page.getByText(/Output cost:/).first()).toHaveText("Output cost: $6.00");
    const inputPrice = page.getByText(/^Input:/).first();
    const outputPrice = page.getByText(/^Output:/).first();
    await expect(inputPrice).toContainText("/ 1M tokens");
    await expect(outputPrice).toContainText("/ 1M tokens");
    await inputPrice.scrollIntoViewIfNeeded();
    for (const price of [inputPrice, outputPrice]) {
      const box = await price.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    await page.getByRole("button", { name: `${day} tokens`, exact: false }).click();
    await expect(page.getByText(/Input cost:/).first()).toHaveText("Input cost: $1.00");
    await expect(page.getByText(/Output cost:/).first()).toHaveText("Output cost: $4.00");
    await page.getByRole("button", { name: "Clear day selection" }).click();
    await expect(page.getByText(/Input cost:/).first()).toHaveText("Input cost: $3.00");
    await expect(page.getByText(/Output cost:/).first()).toHaveText("Output cost: $6.00");
  });
}

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

test("model rate sort reorders rows within each provider group", async ({ page }) => {
  await page.route("**/api/v1/dashboard/metrics?*", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    const data: DashboardMetrics = await response.json();
    const rate = {
      input_per_1m_usd: 2, output_per_1m_usd: 8, source: "https://example.com/pricing",
      inferred: false, confidence: "high" as const, ok: true, status: 200, error: null,
    };
    data.pricing.model_rates = [
      { ...rate, provider: "synthetic-a", model_id: "a-zulu" },
      { ...rate, provider: "synthetic-b", model_id: "b-alpha" },
      { ...rate, provider: "synthetic-a", model_id: "a-alpha" },
      { ...rate, provider: "synthetic-b", model_id: "b-zulu" },
    ];
    data.pricing.aggregator_model_rates = [];
    await route.fulfill({ response, json: data });
  });
  await page.goto("/?tab=dashboard");

  const pricingSection = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Pricing source and assumptions" }) })
    .first();
  await expect(pricingSection).toBeVisible({ timeout: 20_000 });

  const modelSort = pricingSection.locator("select").nth(2);
  const rowList = pricingSection.locator(".max-h-72.overflow-auto").first();

  const models = rowList.locator("span").filter({ hasText: /^[ab]-(alpha|zulu)$/ });
  await modelSort.selectOption("model_asc");
  await expect(models).toHaveText(["a-alpha", "a-zulu", "b-alpha", "b-zulu"]);
  await modelSort.selectOption("model_desc");
  await expect(models).toHaveText(["a-zulu", "a-alpha", "b-zulu", "b-alpha"]);
  await modelSort.selectOption("model_asc");
  await expect(models).toHaveText(["a-alpha", "a-zulu", "b-alpha", "b-zulu"]);
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
