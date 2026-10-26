// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { CostBreakdown } from "./CostBreakdown";
import { MetricCardsGrid } from "./SummaryCards";
import { formatMoney } from "@/lib/dashboard/format";
import type { DashboardCurrencyInfo } from "@/api/types";

const currency: DashboardCurrencyInfo = {
  currency: "GBP", rate_from_usd: 0.8, source: "manual", country_code: null, updated_at: "2026-10-26T00:00:00Z",
};
const costs = { input_cost_usd: 2, output_cost_usd: 10, unattributed_cost_usd: 0 };

it("shows input and output separately in the selected currency", () => {
  render(<CostBreakdown costs={costs} currencyInfo={currency} />);
  expect(screen.getByText(/^Input cost:/).textContent).toBe(`Input cost: ${formatMoney(2, currency)}`);
  expect(screen.getByText(/^Output cost:/).textContent).toBe(`Output cost: ${formatMoney(10, currency)}`);
  expect(screen.queryByText(/Unattributed cost:/)).toBeNull();
});

it("labels recorded costs with an unknown split rather than assigning them to input/output", () => {
  render(<CostBreakdown costs={{ ...costs, unattributed_cost_usd: 7 }} currencyInfo={currency} />);
  expect(screen.getByText(/^Unattributed cost:/).textContent).toBe(`Unattributed cost: ${formatMoney(7, currency)}`);
});

it("shows the selected day's cost split alongside the existing total", () => {
  render(<MetricCardsGrid effectiveSummary={{
    input_tokens_est: 100, output_tokens_est: 50, estimated_cost_usd: 12,
    cost_breakdown: costs, success_rate: 1, error_rate: 0,
  }} selectedDay="2026-10-26" currencyInfo={currency} />);
  expect(screen.getByText("Cost on 2026-10-26 (GBP)")).toBeTruthy();
  expect(screen.getByText(/^Input cost:/).textContent).toBe(`Input cost: ${formatMoney(2, currency)}`);
  expect(screen.getByText(/^Output cost:/).textContent).toBe(`Output cost: ${formatMoney(10, currency)}`);
});
