import { describe, it, expect } from "vitest";
import { modelSupportsImages, isProviderClassified } from "./capabilities";

describe("modelSupportsImages", () => {
  it("recognizes OpenAI vision-capable families", () => {
    expect(modelSupportsImages("openai", "gpt-4o")).toBe(true);
    expect(modelSupportsImages("openai", "gpt-4o-mini")).toBe(true);
    expect(modelSupportsImages("openai", "gpt-4.1")).toBe(true);
    expect(modelSupportsImages("openai", "gpt-4.1-mini-2025-04-14")).toBe(true);
    expect(modelSupportsImages("openai", "gpt-4-turbo")).toBe(true);
    expect(modelSupportsImages("openai", "gpt-4-vision-preview")).toBe(true);
    expect(modelSupportsImages("openai", "gpt-5")).toBe(true);
    expect(modelSupportsImages("openai", "gpt-5-mini")).toBe(true);
    expect(modelSupportsImages("openai", "o1")).toBe(true);
    expect(modelSupportsImages("openai", "o3-mini")).toBe(true);
    expect(modelSupportsImages("openai", "o4-mini")).toBe(true);
    expect(modelSupportsImages("openai", "chatgpt-4o-latest")).toBe(true);
  });

  it("rejects legacy text-only OpenAI models", () => {
    expect(modelSupportsImages("openai", "gpt-3.5-turbo")).toBe(false);
    expect(modelSupportsImages("openai", "text-davinci-003")).toBe(false);
    expect(modelSupportsImages("openai", "gpt-4-0314")).toBe(false);
  });

  it("recognizes Anthropic Claude 3+ as vision-capable", () => {
    expect(modelSupportsImages("anthropic", "claude-3-opus-20240229")).toBe(true);
    expect(modelSupportsImages("anthropic", "claude-3-5-sonnet-20241022")).toBe(true);
    expect(modelSupportsImages("anthropic", "claude-sonnet-4-5")).toBe(true);
    expect(modelSupportsImages("anthropic", "claude-opus-4")).toBe(true);
    expect(modelSupportsImages("anthropic", "claude-haiku-4-5")).toBe(true);
  });

  it("rejects pre-Claude-3 Anthropic models", () => {
    expect(modelSupportsImages("anthropic", "claude-2.1")).toBe(false);
    expect(modelSupportsImages("anthropic", "claude-instant-1.2")).toBe(false);
  });

  it("recognizes Gemini 1.5+ as vision-capable but not legacy gemini-pro", () => {
    expect(modelSupportsImages("gemini", "gemini-1.5-pro")).toBe(true);
    expect(modelSupportsImages("gemini", "gemini-2.0-flash")).toBe(true);
    expect(modelSupportsImages("gemini", "gemini-2.5-flash")).toBe(true);
    expect(modelSupportsImages("gemini", "gemini-pro-vision")).toBe(true);
    expect(modelSupportsImages("gemini", "gemini-pro")).toBe(false);
    expect(modelSupportsImages("gemini", "gemini-1.0-pro")).toBe(false);
  });

  it("mirrors vision-capable upstreams for github-copilot", () => {
    expect(modelSupportsImages("github-copilot", "gpt-4o")).toBe(true);
    expect(modelSupportsImages("github-copilot", "claude-3.5-sonnet")).toBe(true);
    expect(modelSupportsImages("github-copilot", "claude-sonnet-4")).toBe(true);
    expect(modelSupportsImages("github-copilot", "gemini-2.0-flash")).toBe(true);
    expect(modelSupportsImages("github-copilot", "o1")).toBe(true);
    expect(modelSupportsImages("github-copilot", "gpt-3.5-turbo")).toBe(false);
  });

  it("returns false for known text-only providers", () => {
    expect(modelSupportsImages("deepseek", "deepseek-chat")).toBe(false);
    expect(modelSupportsImages("deepseek", "deepseek-reasoner")).toBe(false);
    expect(modelSupportsImages("cohere", "command-r-plus")).toBe(false);
    expect(modelSupportsImages("cohere", "command-a")).toBe(false);
  });

  it("returns false for unknown providers (defensive default)", () => {
    expect(modelSupportsImages("totally-made-up", "gpt-4o")).toBe(false);
  });

  it("is case-insensitive on provider name", () => {
    expect(modelSupportsImages("OpenAI", "gpt-4o")).toBe(true);
    expect(modelSupportsImages("ANTHROPIC", "claude-3-opus")).toBe(true);
  });

  it("does not partially match unrelated ids that happen to contain a known token", () => {
    // 'gpt-4-0314' shouldn't match 'gpt-4-turbo'; 'claude-2-vision' shouldn't
    // match 'claude-3'. We anchor with ^ on every pattern.
    expect(modelSupportsImages("openai", "my-gpt-4o-clone")).toBe(false);
    expect(modelSupportsImages("anthropic", "their-claude-3-clone")).toBe(false);
  });
});

describe("isProviderClassified", () => {
  it("returns true for providers with an explicit capability list", () => {
    expect(isProviderClassified("openai")).toBe(true);
    expect(isProviderClassified("anthropic")).toBe(true);
    expect(isProviderClassified("gemini")).toBe(true);
    expect(isProviderClassified("github-copilot")).toBe(true);
    expect(isProviderClassified("deepseek")).toBe(true);
    expect(isProviderClassified("cohere")).toBe(true);
    expect(isProviderClassified("langchain")).toBe(true);
    expect(isProviderClassified("mock")).toBe(true);
  });

  it("returns false for unknown providers so the UI can show a softer hint", () => {
    expect(isProviderClassified("unknown-provider")).toBe(false);
    expect(isProviderClassified("custom-external")).toBe(false);
  });

  it("is case-insensitive on provider name", () => {
    expect(isProviderClassified("OpenAI")).toBe(true);
    expect(isProviderClassified("GITHUB-COPILOT")).toBe(true);
  });
});
