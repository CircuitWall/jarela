import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADAPTIVE_OUTPUT_TOKEN_CAP,
  getUsageStrategyProfile,
  parseUsageStrategy,
  resolveAdaptiveOutputTokenCap,
  resolveOutputTokenCap,
  resolveUsageStrategy,
  shouldAutoRecall,
} from "./usage-strategy";

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
    expect(parseUsageStrategy(" FAST ")).toBeNull();
    expect(parseUsageStrategy("FAST")).toBeNull();
    expect(parseUsageStrategy(null)).toBeNull();
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

  it("scales the output cap from the turn estimate and adds headroom", () => {
    expect(resolveAdaptiveOutputTokenCap(100, 2_048, 32_768)).toBe(2_048);
    expect(resolveAdaptiveOutputTokenCap(1_000, 2_048, 32_768)).toBe(4_000);
    expect(resolveAdaptiveOutputTokenCap(1_000, DEFAULT_ADAPTIVE_OUTPUT_TOKEN_CAP, 32_768)).toBe(8_192);
  });

  it("does not exceed a hard model, user, or context ceiling", () => {
    expect(resolveAdaptiveOutputTokenCap(10_000, 2_048, 8_192)).toBe(8_192);
    expect(resolveAdaptiveOutputTokenCap(10_000, 2_048, 1_024)).toBe(1_024);
  });

  it("adds explicit thinking tokens without spending the content allocation", () => {
    expect(resolveAdaptiveOutputTokenCap(2_000, 4_096, 64_000, 10_000)).toBe(18_000);
    expect(resolveAdaptiveOutputTokenCap(2_000, 4_096, 12_000, 10_000)).toBe(12_000);
  });

  it("rejects invalid budget inputs instead of producing an unusable provider limit", () => {
    expect(() => resolveAdaptiveOutputTokenCap(NaN, 2_048, 8_192)).toThrow(RangeError);
    expect(() => resolveAdaptiveOutputTokenCap(100, Infinity, 8_192)).toThrow(RangeError);
    expect(() => resolveAdaptiveOutputTokenCap(100, 2_048, 0)).toThrow(RangeError);
  });
});