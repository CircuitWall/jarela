import { describe, expect, it } from "vitest";
import { getUsageStrategyProfile, parseUsageStrategy, resolveOutputTokenCap, resolveUsageStrategy, shouldAutoRecall } from "./usage-strategy";

describe("usage strategy profiles", () => {
  it("automatically recalls only for high reasoning, with profile opt-out", () => {
    expect(shouldAutoRecall("high_reasoning")).toBe(true);
    expect(shouldAutoRecall("balanced")).toBe(false);
    expect(shouldAutoRecall("fast")).toBe(false);
    expect(shouldAutoRecall("cost_saving")).toBe(false);
    expect(shouldAutoRecall("balanced", true)).toBe(false);
    expect(shouldAutoRecall("high_reasoning", false)).toBe(false);
    expect(shouldAutoRecall("high_reasoning", true)).toBe(true);
  });

  it("defaults invalid and missing values to balanced", () => {
    expect(parseUsageStrategy("unknown")).toBeNull();
    expect(resolveUsageStrategy(null, "unknown")).toBe("balanced");
  });

  it("prefers an explicit per-agent override over the global default", () => {
    expect(resolveUsageStrategy("high_reasoning", "cost_saving")).toBe("high_reasoning");
    expect(resolveUsageStrategy(null, "cost_saving")).toBe("cost_saving");
  });

  it("caps context and output, disables stall retries, but permits one provider-failure retry", () => {
    expect(getUsageStrategyProfile("cost_saving")).toMatchObject({
      routerPolicy: "cheap",
      enableRouter: true,
      contextWindowCapTokens: 65_536,
      outputTokenCap: 2_048,
      reduceThinking: true,
      stallRetries: 0,
      providerFailureRetries: 1,
    });
  });

  it("uses one fast profile for routing, response style, budgets, and retries", () => {
    expect(parseUsageStrategy("fast")).toBe("fast");
    expect(getUsageStrategyProfile("fast")).toMatchObject({
      routerPolicy: "fast",
      enableRouter: true,
      contextWindowCapTokens: 32_768,
      outputTokenCap: 2_048,
      stallRetries: 0,
      providerFailureRetries: 1,
      promptInstruction: expect.stringContaining("low-latency response"),
    });
  });

  it("keeps balanced behavior unchanged and routes high reasoning toward quality", () => {
    expect(getUsageStrategyProfile("balanced").promptInstruction).toBe("");
    expect(getUsageStrategyProfile("balanced").providerFailureRetries).toBeNull();
    expect(getUsageStrategyProfile("high_reasoning")).toMatchObject({ routerPolicy: "quality", enableRouter: true });
  });

  it("keeps cost-saving output capped while preserving the thinking floor for other strategies", () => {
    expect(resolveOutputTokenCap(2_048, false, "cost_saving")).toBe(2_048);
    expect(resolveOutputTokenCap(2_048, true, "cost_saving")).toBe(2_048);
    expect(resolveOutputTokenCap(2_048, true, "fast")).toBe(32_768);
    expect(resolveOutputTokenCap(null, true, "balanced")).toBeNull();
  });
});