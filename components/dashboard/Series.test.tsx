// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { DashboardMetrics } from "@/api/types";
import { InteractiveTokenChart } from "./Series";

const series: DashboardMetrics["series"] = [{
  day: "2026-06-01",
  input_tokens_est: 1200,
  output_tokens_est: 400,
  estimated_cost_usd: 0.03,
  tool_calls: 0,
  tool_successes: 0,
  tool_errors: 0,
  success_rate: 0,
  error_rate: 0,
  tier_tokens: {
    hot_tokens: 0,
    warm_tokens: 0,
    facts_tokens: 0,
    overhead_tokens: 0,
    measured_input_tokens: 0,
  },
}];

it("reserves a separate date axis below the token plot", () => {
  render(<InteractiveTokenChart series={series} />);

  const plot = screen.getByRole("group", { name: "Token chart plot" });
  const axis = screen.getByRole("group", { name: "Token chart date axis" });
  const date = screen.getByText("06-01");

  expect(axis.contains(date)).toBe(true);
  expect(plot.contains(date)).toBe(false);
  expect(plot.compareDocumentPosition(axis) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
