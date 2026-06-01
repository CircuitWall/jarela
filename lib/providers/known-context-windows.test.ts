import { describe, it, expect } from "vitest";
import {
  getKnownModelLimits,
  getKnownContextLength,
  getKnownMaxOutputTokens,
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

  it("exposes max_output_tokens too", () => {
    expect(getKnownMaxOutputTokens("openai", "gpt-5")).toBe(128_000);
    expect(getKnownModelLimits("anthropic", "claude-opus-4-7")).toEqual({
      context_length: 1_000_000,
      max_output_tokens: 8192,
    });
  });
});
