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

  it.each([
    ["kimi-k3", 2.9, 14.0],
    ["kimi-k2.7-code", 0.7, 3.5],
    ["kimi-k2.6", 0.58, 3.4],
    ["kimi-k2", 0.57, 2.3],
    ["kimi-k2-thinking", 0.6, 2.5],
    ["moonshot-v1-8k", 1.6, 1.6],
    ["moonshot-v1-32k", 3.3, 3.3],
    ["moonshot-v1-128k", 11, 11],
  ])("returns Kimi rate for %s", (id, input, output) => {
    const r = knownRateFor(id);
    expect(r).not.toBeNull();
    expect(r!.inputPer1M).toBe(input);
    expect(r!.outputPer1M).toBe(output);
  });

  it.each([
    ["qwen-max", 1.6, 6.4],
    ["qwen-plus", 0.4, 1.2],
    ["qwen-turbo", 0.05, 0.2],
    ["qwen3.8-max", 2.0, 6.0],
    ["qwen3.7-max", 1.1, 4.4],
    ["qwen3.7-plus", 0.28, 1.1],
    ["qwen3.7-flash", 0.025, 0.1],
    ["qwen2.5-72b-instruct", 0.35, 0.4],
    ["qwen2.5-7b-instruct", 0.05, 0.1],
    ["qwq-32b", 0.15, 0.6],
  ])("returns Qwen rate for %s", (id, input, output) => {
    const r = knownRateFor(id);
    expect(r).not.toBeNull();
    expect(r!.inputPer1M).toBe(input);
    expect(r!.outputPer1M).toBe(output);
  });
});
