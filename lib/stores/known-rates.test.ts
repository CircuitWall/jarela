import { describe, it, expect } from "vitest";
import { knownRateFor } from "./known-rates";

describe("knownRateFor", () => {
  it("returns null for unknown ids", () => {
    expect(knownRateFor("not-a-real-model")).toBeNull();
    expect(knownRateFor("")).toBeNull();
  });

  it("trims and lowercases the lookup key", () => {
    expect(knownRateFor("  GPT-4O  ")?.inputPer1M).toBe(2.5);
  });

  it("returns the published opus 4.x rate (inputs at $15, outputs at $75)", () => {
    const r = knownRateFor("claude-opus-4-7");
    expect(r).not.toBeNull();
    expect(r!.inputPer1M).toBe(15);
    expect(r!.outputPer1M).toBe(75);
    expect(r!.confidence).toBe("medium");
    expect(r!.inferred).toBe(false);
    expect(r!.ok).toBe(true);
    expect(r!.source).toBe("jarela:known-rates");
  });

  it("returns the published sonnet 4.x rate (inputs at $3, outputs at $15)", () => {
    const r = knownRateFor("claude-sonnet-4-6");
    expect(r!.inputPer1M).toBe(3);
    expect(r!.outputPer1M).toBe(15);
  });

  it("returns the published gpt-4o rate", () => {
    const r = knownRateFor("gpt-4o");
    expect(r!.inputPer1M).toBe(2.5);
    expect(r!.outputPer1M).toBe(10);
  });

  it("does NOT match aggregator-prefixed ids directly (caller must strip)", () => {
    // The fallback in modelRatesFor iterates modelAliasCandidates which
    // strips the post-`/` suffix. The bare table here is intentionally
    // strict — passing the prefixed id should miss.
    expect(knownRateFor("openrouter/openai/gpt-4o")).toBeNull();
  });
});
