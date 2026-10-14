import { describe, expect, it, vi } from "vitest";
import { fetchBytesWithRetry, isRetryableStatus } from "./fetch-with-retry.mjs";

function response(status, body = "", headers = {}) {
  return new Response(body, { status, headers });
}

function options(fetchImpl, extra = {}) {
  return { label: "README.md", fetchImpl, sleep: vi.fn(async () => {}), log: vi.fn(), ...extra };
}

describe("fetchBytesWithRetry", () => {
  it("retries transient 5xx responses and returns the eventual body", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200, "model"));
    const opts = options(fetchImpl);

    const bytes = await fetchBytesWithRetry("https://example.test/a", opts);

    expect(bytes.toString()).toBe("model");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(opts.sleep.mock.calls.map(([ms]) => ms)).toEqual([2_000, 4_000]);
  });

  it("retries network errors", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(response(200, "ok"));

    const bytes = await fetchBytesWithRetry("https://example.test/a", options(fetchImpl));

    expect(bytes.toString()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails immediately on non-retryable HTTP errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(404));
    const opts = options(fetchImpl);

    await expect(fetchBytesWithRetry("https://example.test/a", opts))
      .rejects.toThrow("download failed (404) for README.md");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(opts.sleep).not.toHaveBeenCalled();
  });

  it("gives up after the configured attempts with the last error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(500));
    const opts = options(fetchImpl, { attempts: 3 });

    await expect(fetchBytesWithRetry("https://example.test/a", opts))
      .rejects.toThrow("download failed (500) for README.md after 3 attempts");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(opts.sleep).toHaveBeenCalledTimes(2);
  });

  it("honours Retry-After seconds, capped by the max delay", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(429, "", { "retry-after": "7" }))
      .mockResolvedValueOnce(response(429, "", { "retry-after": "999" }))
      .mockResolvedValueOnce(response(200, "ok"));
    const opts = options(fetchImpl);

    await fetchBytesWithRetry("https://example.test/a", opts);

    expect(opts.sleep.mock.calls.map(([ms]) => ms)).toEqual([7_000, 30_000]);
  });
});

describe("isRetryableStatus", () => {
  it("classifies transient and permanent statuses", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) expect(isRetryableStatus(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 410]) expect(isRetryableStatus(status)).toBe(false);
  });
});
