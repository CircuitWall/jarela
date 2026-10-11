import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
  refreshSnapshot: vi.fn(),
  getDashboardMetrics: vi.fn(),
}));

vi.mock("@/lib/pricing/snapshot", () => ({
  readPricingSnapshot: mocks.readSnapshot,
  refreshPricingSnapshot: mocks.refreshSnapshot,
}));
vi.mock("@/lib/stores/dashboard-metrics", () => ({ getDashboardMetrics: mocks.getDashboardMetrics }));
vi.mock("../packages/langchain-package", () => ({ registerLangChainPackage: vi.fn() }));

import { refreshModelPricing } from "./pricing-maintenance";

describe("refreshModelPricing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readSnapshot.mockResolvedValue({
      generated_at: "2026-10-01T00:00:00.000Z",
      sources: [{ id: "openai", model_rates: [
        { model_id: "gpt-5", input_per_1m_usd: 1, output_per_1m_usd: 2 },
        { model_id: "gpt-4", input_per_1m_usd: 2, output_per_1m_usd: 8 },
        { model_id: "gpt-3.5", input_per_1m_usd: 0.5, output_per_1m_usd: 1.5, confidence: "low" },
      ] }],
    });
    mocks.refreshSnapshot.mockResolvedValue({
      refreshed: true,
      reason: "forced",
      snapshot: {
        generated_at: "2026-10-08T00:00:00.000Z",
        sources: [
          { id: "openai", ok: true, fetched_at: "2026-10-08T00:00:00.000Z", error: null, model_rates: [
            { model_id: "gpt-5", input_per_1m_usd: 1.5, output_per_1m_usd: 2, confidence: "high" },
            { model_id: "gpt-3.5", input_per_1m_usd: 0.5, output_per_1m_usd: 1.5, confidence: "low" },
          ] },
          { id: "anthropic", ok: false, fetched_at: "2026-10-08T00:00:00.000Z", error: "unavailable", model_rates: [] },
        ],
      },
    });
    mocks.getDashboardMetrics.mockResolvedValue({
      days: 30,
      summary: { estimated_cost_usd: 4, recorded_cost_usd: 3 },
      pricing: { snapshot_generated_at: "2026-10-08T00:00:00.000Z" },
    });
  });

  it("returns rate changes, failed sources, and recalculated dashboard totals", async () => {
    const result = await refreshModelPricing();

    expect(mocks.refreshSnapshot).toHaveBeenCalledWith({ force: true });
    expect(mocks.getDashboardMetrics).toHaveBeenCalledWith();
    expect(result.changed_rates).toEqual([{
      provider: "openai",
      model_id: "gpt-5",
      previous_input_per_1m_usd: 1,
      previous_output_per_1m_usd: 2,
      input_per_1m_usd: 1.5,
      output_per_1m_usd: 2,
      confidence: "high",
    }]);
    expect(result.not_returned_rates).toEqual([{
      provider: "openai",
      model_id: "gpt-4",
      input_per_1m_usd: 2,
      output_per_1m_usd: 8,
      note: "Not returned by the current extraction; this may be an extraction gap, not a confirmed provider removal.",
    }]);
    expect(result.sources).toEqual([
      expect.objectContaining({
        id: "openai",
        ok: true,
        model_rate_count: 2,
        low_confidence_model_ids: ["gpt-3.5"],
        notes: undefined,
      }),
      expect.objectContaining({ id: "anthropic", ok: false, error: "unavailable" }),
    ]);
    expect(result.dashboard).toMatchObject({
      current_rate_estimated_cost_usd: 4,
      recorded_snapshot_cost_usd: 3,
    });
  });
});