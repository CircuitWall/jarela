import { describe, it, expect } from "vitest";
import { computeDataQuality, recalculateSnapshotCost } from "./dashboard-metrics";
import type { PricingTables, ProviderRates } from "./pricing";

function pricingTables(rate: ProviderRates | null): PricingTables {
  const rates: ProviderRates = rate ?? {
    inputPer1M: null,
    outputPer1M: null,
    source: "snapshot-missing",
    inferred: true,
    confidence: "low",
    ok: false,
    status: null,
    error: "missing",
  };
  return {
    byProvider: new Map([["openai", rates]]),
    byProviderModel: new Map(rate ? [["openai::gpt-5", rate]] : []),
    byModel: new Map(rate ? [["gpt-5", rate]] : []),
    aggregatorSources: [],
    aggregatorModelRates: [],
    generatedAt: null,
  };
}

describe("computeDataQuality", () => {
  it("treats empty windows as fully measured to avoid a misleading red chip", () => {
    expect(computeDataQuality(0, 0)).toEqual({
      measured_messages: 0,
      estimated_messages: 0,
      measured_pct: 1,
    });
  });

  it("reports the measured ratio for mixed windows", () => {
    expect(computeDataQuality(9, 1)).toEqual({
      measured_messages: 9,
      estimated_messages: 1,
      measured_pct: 0.9,
    });
  });

  it("rounds to four decimals", () => {
    const q = computeDataQuality(1, 2);
    expect(q.measured_pct).toBe(0.3333);
  });

  it("reports 0% when every row is a legacy estimate", () => {
    expect(computeDataQuality(0, 7)).toEqual({
      measured_messages: 0,
      estimated_messages: 7,
      measured_pct: 0,
    });
  });
});

describe("recalculateSnapshotCost", () => {
  it("uses current rates while leaving the recorded value as input-only history", () => {
    expect(recalculateSnapshotCost({
      provider: "openai",
      modelId: "gpt-5",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheCreationTokens: null,
      cacheReadTokens: null,
      recordedCostUsd: 2,
    }, pricingTables({
      inputPer1M: 3,
      outputPer1M: 10,
      source: "official",
      inferred: false,
      confidence: "high",
      ok: true,
      status: 200,
      error: null,
    }))).toBeCloseTo(4, 6);
  });

  it("falls back to the recorded value when no current rate is available", () => {
    expect(recalculateSnapshotCost({
      provider: "openai",
      modelId: "unknown",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheCreationTokens: null,
      cacheReadTokens: null,
      recordedCostUsd: 2.5,
    }, pricingTables(null))).toBe(2.5);
  });
});
