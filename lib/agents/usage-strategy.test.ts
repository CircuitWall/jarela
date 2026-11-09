import { describe, expect, it } from "vitest";
import {
  applyTokenBudgetRatio,
  getUsageStrategyProfile,
  parseUsageStrategy,
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
    expect(shouldAutoRecall("balanced", true, true)).toBe(true);
    expect(shouldAutoRecall("cost_saving", true, true)).toBe(true);
    expect(shouldAutoRecall("balanced", false, true)).toBe(false);
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

  it("caps context, disables stall retries, but permits one provider-failure retry", () => {
    expect(getUsageStrategyProfile("cost_saving")).toMatchObject({
      routerPolicy: "cheap",
      enableRouter: true,
      contextWindowRatio: 0.6,
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
      contextWindowRatio: 0.5,
      stallRetries: 0,
      providerFailureRetries: 1,
      promptInstruction: expect.stringContaining("low-latency response"),
    });
  });

  it("keeps balanced behavior unchanged and routes high reasoning toward quality", () => {
    expect(getUsageStrategyProfile("balanced")).toMatchObject({
      promptInstruction: "",
      contextWindowRatio: 0.8,
    });
    expect(getUsageStrategyProfile("balanced").providerFailureRetries).toBeNull();
    expect(getUsageStrategyProfile("high_reasoning")).toMatchObject({
      routerPolicy: "quality",
      enableRouter: true,
      contextWindowRatio: 1,
    });
  });

  it("scales token budgets against model limits without exceeding them", () => {
    expect(applyTokenBudgetRatio(128_000, 0.6)).toBe(76_800);
    expect(applyTokenBudgetRatio(128_000, 0.5)).toBe(64_000);
    expect(applyTokenBudgetRatio(128_000, 0.8)).toBe(102_400);
    expect(applyTokenBudgetRatio(128_000, 1)).toBe(128_000);
    expect(applyTokenBudgetRatio(10, 0.8)).toBe(8);
    expect(() => applyTokenBudgetRatio(0, 0.8)).toThrow(RangeError);
    expect(() => applyTokenBudgetRatio(100, 1.01)).toThrow(RangeError);
  });

});
