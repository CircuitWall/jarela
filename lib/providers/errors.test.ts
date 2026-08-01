import { describe, it, expect } from "vitest";
import { ProviderAuthError, isAuthErrorMessage, isAuthHttpStatus } from "./errors";

describe("ProviderAuthError", () => {
  it("carries provider, status, and code=auth_failed", () => {
    const e = new ProviderAuthError("gemini", "API_KEY_INVALID", 400);
    expect(e.provider).toBe("gemini");
    expect(e.status).toBe(400);
    expect(e.code).toBe("auth_failed");
    expect(e.name).toBe("ProviderAuthError");
    expect(e instanceof Error).toBe(true);
  });
  it("defaults status to null", () => {
    expect(new ProviderAuthError("openai", "boom").status).toBe(null);
  });
});

describe("isAuthHttpStatus", () => {
  it("recognises 401 and 403", () => {
    expect(isAuthHttpStatus(401)).toBe(true);
    expect(isAuthHttpStatus(403)).toBe(true);
  });
  it("excludes throttling and other 4xx", () => {
    expect(isAuthHttpStatus(429)).toBe(false);
    expect(isAuthHttpStatus(400)).toBe(false);
    expect(isAuthHttpStatus(404)).toBe(false);
    expect(isAuthHttpStatus(500)).toBe(false);
    expect(isAuthHttpStatus(null)).toBe(false);
    expect(isAuthHttpStatus(undefined)).toBe(false);
  });
});

describe("isAuthErrorMessage", () => {
  it.each([
    ["Gemini chat stream error: 400 { \"error\": { \"status\": \"INVALID_ARGUMENT\", \"code\": 400, \"message\": \"API_KEY_INVALID\" }}"],
    ["OpenAI 401 Unauthorized: Incorrect API key provided"],
    ["Anthropic 403 forbidden"],
    ["invalid api key"],
    ["Invalid_API_Key: sk-…"],
    ["Authentication error: token has expired"],
    ["Request had invalid authentication credentials"],
    ["refresh_token expired"],
    ["access token revoked"],
    ["permission denied on resource"],
    ["401 unauthorized token"],
  ])("classifies %j as auth", (msg) => {
    expect(isAuthErrorMessage(msg)).toBe(true);
  });

  it.each([
    ["context_length_exceeded: too many tokens"],
    ["The input token count (1234567) exceeds the maximum number of tokens allowed"],
    ["429 rate limit exceeded"],
    ["ECONNREFUSED"],
    ["timeout after 30s"],
    ["model gpt-401 not found"],
    [""],
    [null],
    [undefined],
  ])("does not classify %j as auth", (msg) => {
    expect(isAuthErrorMessage(msg)).toBe(false);
  });
});
