import { describe, it, expect } from "vitest";
import { isContextOverflowError, parseContextLimitFromError } from "./llm";

describe("isContextOverflowError", () => {
  it("matches OpenAI phrasing", () => {
    expect(isContextOverflowError("This model's maximum context length is 128000 tokens. However, your messages resulted in 213998 tokens")).toBe(true);
  });
  it("matches Anthropic phrasing", () => {
    expect(isContextOverflowError("prompt is too long: 235812 tokens > 200000 maximum")).toBe(true);
  });
  it("matches Gemini phrasing", () => {
    expect(isContextOverflowError("The input token count (1234567) exceeds the maximum number of tokens allowed (1048576).")).toBe(true);
  });
  it("ignores unrelated errors", () => {
    expect(isContextOverflowError("fetch failed: ECONNREFUSED")).toBe(false);
    expect(isContextOverflowError("")).toBe(false);
  });
});

describe("parseContextLimitFromError", () => {
  it("parses OpenAI limit + requested", () => {
    expect(
      parseContextLimitFromError("This model's maximum context length is 128000 tokens. However, your messages resulted in 213998 tokens"),
    ).toEqual({ limit: 128000, requested: 213998 });
  });
  it("parses OpenAI 'requested' phrasing", () => {
    expect(
      parseContextLimitFromError("This model's maximum context length is 8192 tokens, however you requested 9000 tokens"),
    ).toEqual({ limit: 8192, requested: 9000 });
  });
  it("parses Anthropic phrasing", () => {
    expect(
      parseContextLimitFromError("prompt is too long: 235812 tokens > 200000 maximum"),
    ).toEqual({ limit: 200000, requested: 235812 });
  });
  it("parses Gemini phrasing", () => {
    expect(
      parseContextLimitFromError("The input token count (1234567) exceeds the maximum number of tokens allowed (1048576)."),
    ).toEqual({ limit: 1048576, requested: 1234567 });
  });
  it("parses DeepSeek range phrasing", () => {
    expect(
      parseContextLimitFromError("Range of input length should be [1, 65536]"),
    ).toEqual({ limit: 65536 });
  });
  it("strips comma grouping", () => {
    expect(
      parseContextLimitFromError("This model's maximum context length is 1,047,576 tokens"),
    ).toEqual({ limit: 1047576 });
  });
  it("returns null when no number pair is present", () => {
    expect(parseContextLimitFromError("context window exhausted, retry later")).toBeNull();
    expect(parseContextLimitFromError("")).toBeNull();
  });
});
