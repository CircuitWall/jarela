import { describe, it, expect } from "vitest";
import {
  getKnownModelLimits,
  getKnownContextLength,
  getKnownMaxOutputTokens,
  stripSupersededLimits,
} from "./known-context-windows";

describe("known-context-windows", () => {
  it("returns null for unknown provider", () => {
    expect(getKnownContextLength("unknown-provider", "gpt-4o")).toBeNull();
  });

  it("returns null for unknown model id", () => {
    expect(getKnownContextLength("openai", "totally-made-up-model")).toBeNull();
  });

  it("resolves anthropic claude opus 4.7 to 1M", () => {
    expect(getKnownContextLength("anthropic", "claude-opus-4-7")).toBe(1_000_000);
  });

  it("resolves gemini 2.5 pro to 1M+", () => {
    expect(getKnownContextLength("gemini", "gemini-2.5-pro")).toBe(1_048_576);
  });

  it("resolves openai gpt-4o by longest prefix", () => {
    expect(getKnownContextLength("openai", "gpt-4o-2024-08-06")).toBe(128_000);
  });

  it("does not collapse gpt-4o to gpt-4 (shortest prefix would be wrong)", () => {
    expect(getKnownContextLength("openai", "gpt-4o")).toBe(128_000);
    expect(getKnownContextLength("openai", "gpt-4")).toBe(8192);
  });

  it("resolves copilot proxy ids to underlying vendor model", () => {
    expect(getKnownContextLength("github-copilot", "Github-Opus4.6")).toBe(1_000_000);
    expect(getKnownContextLength("github-copilot", "claude-sonnet-4")).toBe(200_000);
    expect(getKnownContextLength("github-copilot", "gemini-2.5-pro")).toBe(1_048_576);
    expect(getKnownContextLength("github-copilot", "gpt-4o")).toBe(128_000);
    expect(getKnownContextLength("github-copilot", "o3")).toBe(200_000);
  });

  it("resolves DeepSeek V4 models to 1M context and 384K output (393216 tokens)", () => {
    for (const id of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"]) {
      expect(getKnownModelLimits("deepseek", id)).toEqual({ context_length: 1_000_000, max_output_tokens: 393_216 });
    }
    expect(getKnownContextLength("deepseek", "deepseek-chat")).toBeNull();
  });

  it("exposes max_output_tokens too", () => {
    expect(getKnownMaxOutputTokens("openai", "gpt-5")).toBe(128_000);
    expect(getKnownModelLimits("anthropic", "claude-opus-4-7")).toEqual({
      context_length: 1_000_000,
      max_output_tokens: 8192,
    });
  });
});

describe("stripSupersededLimits", () => {
  it("drops a context/output pair copied from a previous catalog snapshot", () => {
    expect(stripSupersededLimits("deepseek", "deepseek-v4-flash", {
      api_key: "sk-x",
      context_window_tokens: 65_536,
      max_tokens: 8_192,
    })).toEqual({ api_key: "sk-x" });
  });

  it("keeps a deliberate cap, because only the exact pair is stale", () => {
    const onlyMax = { max_tokens: 8_192 };
    const lowerCap = { context_window_tokens: 65_536, max_tokens: 4_096 };
    const current = { context_window_tokens: 1_000_000, max_tokens: 8_192 };
    expect(stripSupersededLimits("deepseek", "deepseek-v4-flash", onlyMax)).toEqual(onlyMax);
    expect(stripSupersededLimits("deepseek", "deepseek-v4-flash", lowerCap)).toEqual(lowerCap);
    expect(stripSupersededLimits("deepseek", "deepseek-v4-flash", current)).toEqual(current);
  });

  it("leaves other providers and models alone", () => {
    const params = { context_window_tokens: 65_536, max_tokens: 8_192 };
    expect(stripSupersededLimits("openai", "gpt-4", params)).toEqual(params);
    expect(stripSupersededLimits("deepseek", "deepseek-flash", params)).toEqual(params);
  });
});
