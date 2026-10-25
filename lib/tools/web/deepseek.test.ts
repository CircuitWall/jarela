import { afterEach, describe, expect, it, vi } from "vitest";
import { postDeepSeekWebTool } from "./deepseek";

vi.mock("@/lib/stores/integrations", () => ({
  getIntegrationRaw: vi.fn(() => null),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DeepSeek web API boundary", () => {
  it.each([
    [401, /API key/i],
    [402, /insufficient balance/i],
    [403, /security policy/i],
    [404, /usable page content/i],
    [429, /request limit/i],
    [504, /HTTP 504/i],
  ])("sanitizes HTTP %s without exposing provider bodies", async (status, expected) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("synthetic-sensitive-error-body", { status }));
    const result = postDeepSeekWebTool("fetch", "synthetic-key", { url: "https://example.com/" });
    await expect(result).rejects.toThrow(expected);
    await expect(result).rejects.not.toThrow("synthetic-sensitive-error-body");
  });

  it("does not expose arbitrary transport error messages", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("synthetic-sensitive-request-detail"));
    await expect(postDeepSeekWebTool("search", "synthetic-key", { query: "test" }))
      .rejects.toThrow("DeepSeek Search request failed. Check network connectivity and retry.");
  });

  it("rejects malformed JSON without echoing response content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not JSON: synthetic-sensitive-response"));
    await expect(postDeepSeekWebTool("search", "synthetic-key", { query: "test" }))
      .rejects.toThrow("DeepSeek Search returned invalid JSON.");
  });

  it("rejects responses exceeding the byte limit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x".repeat(1_000_001)));
    await expect(postDeepSeekWebTool("search", "synthetic-key", { query: "test" }))
      .rejects.toThrow("larger than 1 MB");
  });

  it("uses the requested timeout and reports it without transport details", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("synthetic-timeout-detail")), { once: true });
    }));
    const result = postDeepSeekWebTool("fetch", "synthetic-key", { url: "https://example.com/" }, undefined, 120_000);
    const rejection = expect(result).rejects.toThrow(/DeepSeek Fetch timed out.*120s/i);
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
    expect(AbortSignal.timeout).toHaveBeenCalledWith(120_000);
  });

  it("honors caller cancellation and refuses redirects", async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("synthetic-cancellation-detail")), { once: true });
    }));
    const result = postDeepSeekWebTool("search", "synthetic-key", { query: "test" }, controller.signal);
    const rejection = expect(result).rejects.toThrow(/cancelled/i);
    controller.abort();
    await rejection;
    expect(fetch).toHaveBeenCalledWith("https://api.deepseek.com/v1/tools/search", expect.objectContaining({
      redirect: "error",
    }));
  });
});
