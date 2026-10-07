import { describe, expect, it } from "vitest";
import { getUsageStrategyProfile, parseUsageStrategy, resolveOutputTokenCap, resolveUsageStrategy } from "./usage-strategy";

describe("usage strategy profiles", () => {
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
      outputTokenCap: 4_096,
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

  it("raises a tight output cap only for thinking models", () => {
    expect(resolveOutputTokenCap(2_048, false)).toBe(2_048);
    expect(resolveOutputTokenCap(2_048, true)).toBe(32_768);
    expect(resolveOutputTokenCap(null, true)).toBeNull();
  });
});