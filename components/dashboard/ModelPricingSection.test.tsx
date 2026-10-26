// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { DashboardMetrics, DashboardCurrencyInfo } from "@/api/types";
import { ModelPricingSection } from "./ModelPricingSection";
import { formatMoney } from "@/lib/dashboard/format";

const currency: DashboardCurrencyInfo = {
  currency: "USD", rate_from_usd: 1, country_code: null, source: "default", updated_at: "2026-10-26T00:00:00Z",
};
const rates: DashboardMetrics["pricing"]["model_rates"] = [{
  provider: "synthetic", model_id: "synthetic-model", input_per_1m_usd: 2, output_per_1m_usd: 10,
  source: "https://example.com/pricing", inferred: false, confidence: "high", ok: true, status: 200, error: null,
}];
const pricing: DashboardMetrics["pricing"] = {
  snapshot_generated_at: null, rates: [], model_rates: rates, aggregator_sources: [], aggregator_model_rates: [], notes: "Synthetic pricing",
};

function renderPricing(modelRates = rates) {
  render(<ModelPricingSection
    pricing={{ ...pricing, model_rates: modelRates }}
    modelVendorFilter="all" onVendorFilterChange={vi.fn()}
    modelFunctionFilter="all" onFunctionFilterChange={vi.fn()}
    modelSearch="" onSearchChange={vi.fn()}
    modelSort="model_asc" onSortChange={vi.fn()} currencyInfo={currency}
  />);
}

it("labels distinct input/output rates with their token unit rather than in/out abbreviations", () => {
  renderPricing();
  const input = screen.getByText(/^Input:/);
  const output = screen.getByText(/^Output:/);
  expect(input.textContent).toBe(`Input: ${formatMoney(2, currency)} / 1M tokens`);
  expect(output.textContent).toBe(`Output: ${formatMoney(10, currency)} / 1M tokens`);
  expect(screen.getByText(/Separate input and output prices per 1 million tokens \(USD\)/)).toBeTruthy();
});

it("distinguishes a free rate from an unknown rate", () => {
  renderPricing([{ ...rates[0], input_per_1m_usd: 0, output_per_1m_usd: null }]);
  expect(screen.getByText(/^Input:/).textContent).toBe(`Input: ${formatMoney(0, currency)} / 1M tokens`);
  expect(screen.getByText(/^Output:/).textContent).toBe("Output: n/a / 1M tokens");
});
