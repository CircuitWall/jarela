import { describe, it, expect } from "vitest";
import { classifyProviderError } from "./provider-errors";

describe("classifyProviderError — auth", () => {
  it("matches 401 status text", () => {
    const r = classifyProviderError("Anthropic 401 Unauthorized: invalid API key");
    expect(r?.code).toBe("auth_error");
    expect(r?.retryable).toBe(false);
  });

  it("matches 'invalid api key' phrasing", () => {
    expect(classifyProviderError("Error: invalid API key provided")?.code).toBe("auth_error");
  });

  it("matches Microsoft AADSTS error codes", () => {
    expect(classifyProviderError("AADSTS70001: User not found")?.code).toBe("auth_error");
  });

  it("matches 'authentication failed'", () => {
    expect(classifyProviderError("authentication failed: bad credentials")?.code).toBe("auth_error");
  });

  it("yields a non-retryable result with a friendly message", () => {
    const r = classifyProviderError("401 Unauthorized");
    expect(r?.retryable).toBe(false);
    expect(r?.message).toMatch(/api[_ ]key|reconnect|Settings/i);
  });
});

describe("classifyProviderError — rate limit", () => {
  it("matches 429 status text", () => {
    const r = classifyProviderError("OpenAI 429: Too Many Requests");
    expect(r?.code).toBe("rate_limit");
    expect(r?.retryable).toBe(true);
  });

  it("extracts retry-after seconds when present", () => {
    const r = classifyProviderError("Rate limit hit. Retry after 30 seconds.");
    expect(r?.code).toBe("rate_limit");
    expect(r?.retryAfterMs).toBe(30_000);
  });

  it("extracts retry-after with explicit unit", () => {
    const r = classifyProviderError("rate limit; retry-after: 12s");
    expect(r?.retryAfterMs).toBe(12_000);
  });

  it("handles ms units", () => {
    const r = classifyProviderError("rate limit; retry-after 500ms");
    expect(r?.retryAfterMs).toBe(500);
  });

  it("is undefined when no retry-after is in the message", () => {
    const r = classifyProviderError("429 Too Many Requests");
    expect(r?.retryAfterMs).toBeUndefined();
  });
});

describe("classifyProviderError — billing", () => {
  it("matches insufficient_quota", () => {
    expect(classifyProviderError("insufficient_quota: please upgrade")?.code).toBe("billing_error");
  });

  it("matches 402 Payment Required", () => {
    expect(classifyProviderError("402 Payment Required")?.code).toBe("billing_error");
  });

  it("is non-retryable (no point auto-retrying a billing failure)", () => {
    expect(classifyProviderError("billing: account suspended")?.retryable).toBe(false);
  });
});

describe("classifyProviderError — model not found", () => {
  it("matches typical phrasings", () => {
    expect(classifyProviderError("model 'gpt-x' not found")?.code).toBe("model_not_found");
    expect(classifyProviderError("unsupported model: claude-foo")?.code).toBe("model_not_found");
    expect(classifyProviderError("This model is deprecated")?.code).toBe("model_not_found");
  });

  it("is non-retryable", () => {
    expect(classifyProviderError("model not found")?.retryable).toBe(false);
  });
});

describe("classifyProviderError — network", () => {
  it("matches common Node fetch error names", () => {
    expect(classifyProviderError("ECONNRESET reading socket")?.code).toBe("network_error");
    expect(classifyProviderError("getaddrinfo ENOTFOUND api.openai.com")?.code).toBe("network_error");
    expect(classifyProviderError("ETIMEDOUT")?.code).toBe("network_error");
  });

  it("matches 'fetch failed' (undici flat shape)", () => {
    expect(classifyProviderError("fetch failed")?.code).toBe("network_error");
  });

  it("is retryable with default 2s backoff when no hint is present", () => {
    const r = classifyProviderError("ECONNRESET");
    expect(r?.retryable).toBe(true);
    expect(r?.retryAfterMs).toBe(2_000);
  });
});

describe("classifyProviderError — priority", () => {
  it("auth wins over rate-limit when both phrases appear", () => {
    // Some proxies stuff retry advice into 401 bodies. The recovery is
    // different (fix the key, not wait + retry) so auth must win.
    expect(classifyProviderError("401 Unauthorized; rate limit also")?.code).toBe("auth_error");
  });

  it("billing wins over rate-limit", () => {
    expect(classifyProviderError("insufficient_quota; rate limit may apply")?.code).toBe("billing_error");
  });

  it("returns null on truly unrecognised messages", () => {
    expect(classifyProviderError("a random LangChain stack trace")).toBeNull();
    expect(classifyProviderError("")).toBeNull();
  });
});
