import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "./types";
import { DEFAULT_PROVIDER_RATE_LIMITS, parseRateLimitOverrides, ProviderRateLimiter, withProviderRateLimits } from "./rate-limit";

vi.mock("./external", () => ({ loadExternalProviders: () => ({}) }));
vi.mock("@/lib/env/config", () => ({
  getConfig: () => ({ enableMockProvider: false, providerRateLimits: "" }),
}));
vi.mock("./openai", async (importOriginal) => ({
  ...await importOriginal<typeof import("./openai")>(),
  openaiProvider: {
    name: "openai",
    chat: vi.fn(async () => ({ stream: (async function* () { yield "ok"; })() })),
    invoke: vi.fn(async () => ({ text: "ok", tool_calls: [], stop_reason: "stop" })),
  },
}));

afterEach(() => vi.useRealTimers());

describe("provider rate limits", () => {
  it("limits known providers and leaves unknown providers unlimited", () => {
    const limiter = new ProviderRateLimiter();
    for (const name of Object.keys(DEFAULT_PROVIDER_RATE_LIMITS)) {
      const limits = limiter.limitsFor(name);
      expect(Number.isFinite(limits.requestsPerMinute) || Number.isFinite(limits.maxConcurrent)).toBe(true);
    }
    expect(limiter.limitsFor("custom-provider")).toEqual({ requestsPerMinute: Infinity, maxConcurrent: Infinity });
    expect(limiter.limitsFor("mock")).toEqual({ requestsPerMinute: Infinity, maxConcurrent: Infinity });
    expect(limiter.limitsFor("langchain", { lc_class: "ChatCohere" }).requestsPerMinute).toBe(20);
  });

  it("validates overrides and supports JSON null for unlimited", () => {
    expect(parseRateLimitOverrides('{"openai":{"requestsPerMinute":null,"maxConcurrent":2}}'))
      .toEqual({ openai: { requestsPerMinute: Infinity, maxConcurrent: 2 } });
    expect(parseRateLimitOverrides("")).toEqual({});
    for (const raw of ['{"openai":{"requestsPerMinute":0}}', '{"openai":{"requestsPerMinute":-1}}', '{"openai":{"requestsPerMinute":"infinity"}}', "not json"]) {
      expect(() => parseRateLimitOverrides(raw)).toThrow();
    }
  });

  it("paces requests across models, credentials, and adapter wrappers", async () => {
    vi.useFakeTimers();
    const limiter = new ProviderRateLimiter({ openai: { requestsPerMinute: 60 } });
    const invoke = vi.fn(async () => ({ text: "ok", tool_calls: [], stop_reason: "stop" as const }));
    const provider: ModelProvider = { name: "openai", chat: vi.fn(), invoke };
    const first = withProviderRateLimits(provider, limiter).invoke!("one", [], { api_key: "synthetic-one" }, []);
    const second = withProviderRateLimits(provider, limiter).invoke!("two", [], { api_key: "synthetic-two" }, []);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("cancels queued work before calling the provider", async () => {
    vi.useFakeTimers();
    const limiter = new ProviderRateLimiter({ openai: { requestsPerMinute: 60 } });
    const release = await limiter.acquire("openai", {});
    const controller = new AbortController();
    const pending = limiter.acquire("openai", {}, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    release();
    await vi.advanceTimersByTimeAsync(1000);
  });

  it("holds concurrency until the stream ends or is closed", async () => {
    const limiter = new ProviderRateLimiter({ custom: { maxConcurrent: 1 } });
    const provider: ModelProvider = {
      name: "custom",
      chat: vi.fn(async () => ({ stream: (async function* () { yield "one"; yield "two"; })() })),
    };
    const wrapped = withProviderRateLimits(provider, limiter);
    const first = await wrapped.chat("model", [], {});
    const second = wrapped.chat("model", [], {});
    const iterator = first.stream[Symbol.asyncIterator]();
    await iterator.next();
    expect(provider.chat).toHaveBeenCalledTimes(1);
    await iterator.return!();
    const next = await second;
    expect(provider.chat).toHaveBeenCalledTimes(2);
    for await (const chunk of next.stream) expect(chunk).toBeTypeOf("string");
  });

  it("releases concurrency on provider errors", async () => {
    const limiter = new ProviderRateLimiter({ custom: { maxConcurrent: 1 } });
    const invoke = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue({ text: "ok", tool_calls: [], stop_reason: "stop" });
    const wrapped = withProviderRateLimits({ name: "custom", chat: vi.fn(), invoke }, limiter);
    await expect(wrapped.invoke!("model", [], {}, [])).rejects.toThrow("failed");
    await expect(wrapped.invoke!("model", [], {}, [])).resolves.toMatchObject({ text: "ok" });
  });

  it("releases concurrency when an unconsumed chat stream is closed", async () => {
    const limiter = new ProviderRateLimiter({ custom: { maxConcurrent: 1 } });
    const chat = vi.fn(async () => ({ stream: (async function* () { yield "ok"; })() }));
    const wrapped = withProviderRateLimits({ name: "custom", chat }, limiter);
    const first = await wrapped.chat("model", [], {});
    const pending = wrapped.chat("model", [], {});
    await first.stream[Symbol.asyncIterator]().return!();
    const second = await pending;
    for await (const chunk of second.stream) expect(chunk).toBe("ok");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("does not release active concurrency until an aborted invocation settles", async () => {
    const limiter = new ProviderRateLimiter({ custom: { maxConcurrent: 1 } });
    const result = { text: "ok", tool_calls: [], stop_reason: "stop" as const };
    const active = Promise.withResolvers<typeof result>();
    const invoke = vi.fn().mockReturnValueOnce(active.promise).mockResolvedValue(result);
    const wrapped = withProviderRateLimits({ name: "custom", chat: vi.fn(), invoke }, limiter);
    const controller = new AbortController();
    const first = wrapped.invoke!("model", [], {}, [], controller.signal);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const second = wrapped.invoke!("model", [], {}, []);
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    active.resolve(result);
    await Promise.all([first, second]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("shares the same pacing budget between streamed tool calls and embeddings", async () => {
    vi.useFakeTimers();
    const limiter = new ProviderRateLimiter({ custom: { requestsPerMinute: 60 } });
    const streamInvoke = vi.fn(async function* () { yield { type: "text" as const, delta: "ok" }; });
    const embed = vi.fn(async () => [[1, 2]]);
    const wrapped = withProviderRateLimits({ name: "custom", chat: vi.fn(), streamInvoke, embed }, limiter);
    const iterator = wrapped.streamInvoke!("model", [], {}, [])[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return!();
    const pending = wrapped.embed!("model", ["text"], {});
    await vi.advanceTimersByTimeAsync(999);
    expect(embed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual([[1, 2]]);
  });

  it("releases a stream slot on abort even before the stream is consumed", async () => {
    const limiter = new ProviderRateLimiter({ custom: { maxConcurrent: 1 } });
    const chat = vi.fn(async () => ({ stream: (async function* () { yield "ok"; })() }));
    const wrapped = withProviderRateLimits({ name: "custom", chat }, limiter);
    const controller = new AbortController();
    await wrapped.chat("model", [], {}, controller.signal);
    const pending = wrapped.chat("model", [], {});
    controller.abort();
    const result = await pending;
    for await (const chunk of result.stream) expect(chunk).toBe("ok");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("leaves unknown provider calls unrestricted and preserves optional methods", async () => {
    const invoke = vi.fn(async () => ({ text: "ok", tool_calls: [], stop_reason: "stop" as const }));
    const listModels = vi.fn(async () => []);
    const wrapped = withProviderRateLimits({ name: "unknown", chat: vi.fn(), invoke, listModels }, new ProviderRateLimiter());
    await Promise.all(Array.from({ length: 20 }, () => wrapped.invoke!("model", [], {}, [])));
    expect(invoke).toHaveBeenCalledTimes(20);
    expect(wrapped.streamInvoke).toBeUndefined();
    expect(wrapped.embed).toBeUndefined();
    await wrapped.listModels!({});
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("enforces the shared limiter through getProvider", async () => {
    vi.useFakeTimers();
    const { getProvider } = await import("./index");
    const { openaiProvider } = await import("./openai");
    const first = getProvider("openai");
    const second = getProvider("openai");
    expect(first).toBe(second);
    expect(first).not.toBe(openaiProvider);
    const requests = [first.invoke!("model-one", [], {}, []), second.invoke!("model-two", [], {}, [])];
    await vi.advanceTimersByTimeAsync(0);
    expect(openaiProvider.invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(requests);
    expect(openaiProvider.invoke).toHaveBeenCalledTimes(2);
  });
});