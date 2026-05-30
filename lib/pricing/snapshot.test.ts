import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();
const mkdirMock = vi.fn();
const writeFileMock = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile: readFileMock,
  mkdir: mkdirMock,
  writeFile: writeFileMock,
}));

describe("pricing snapshot refresh", () => {
  beforeEach(() => {
    vi.resetModules();
    readFileMock.mockReset();
    mkdirMock.mockReset();
    writeFileMock.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes and writes snapshot when cache is missing", async () => {
    readFileMock.mockRejectedValueOnce(new Error("ENOENT"));

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => "<html>input $1.00 / 1M tokens output $2.00 / 1M tokens</html>",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { refreshPricingSnapshot } = await import("./snapshot");
    const res = await refreshPricingSnapshot({ force: true, ttlDays: 2 });

    expect(res.refreshed).toBe(true);
    expect(res.reason).toBe("forced");
    expect(res.snapshot.sources.length).toBeGreaterThan(0);
    expect(res.snapshot.ttl_days).toBe(2);
    expect(fetchMock).toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it("returns fresh cache without fetching when snapshot is within ttl", async () => {
    const fresh = {
      generated_at: new Date().toISOString(),
      disclaimer: "cached",
      ttl_days: 3,
      sources: [],
    };
    readFileMock.mockResolvedValueOnce(JSON.stringify(fresh));

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { refreshPricingSnapshot } = await import("./snapshot");
    const res = await refreshPricingSnapshot({ force: false, ttlDays: 3 });

    expect(res.refreshed).toBe(false);
    expect(res.reason).toBe("fresh");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("refreshes only requested providers and preserves cached others", async () => {
    const stale = {
      generated_at: new Date(Date.now() - (10 * 24 * 60 * 60 * 1000)).toISOString(),
      disclaimer: "cached",
      ttl_days: 3,
      sources: [
        {
          id: "openai",
          name: "OpenAI",
          pricing_url: "https://openai.com/api/pricing/",
          notes: "cached",
          fetched_at: new Date().toISOString(),
          ok: true,
          status: 200,
          etag: null,
          last_modified: null,
          content_hash: "old",
          content_length: 10,
          price_signals: ["$1.00 / 1M tokens"],
          error: null,
        },
      ],
    };
    readFileMock.mockResolvedValueOnce(JSON.stringify(stale));

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => "<html>$0.50 / 1M tokens</html>",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { refreshPricingSnapshot } = await import("./snapshot");
    const res = await refreshPricingSnapshot({ force: false, ttlDays: 3, providers: ["deepseek"] });

    expect(res.refreshed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstFetchUrl = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0];
    expect(firstFetchUrl).toBeDefined();
    expect(String(firstFetchUrl)).toContain("deepseek");
    const ids = res.snapshot.sources.map((s) => s.id);
    expect(ids).toContain("deepseek");
    expect(ids).toContain("openai");
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to Google results when provider pages fail", async () => {
    readFileMock.mockRejectedValueOnce(new Error("ENOENT"));

    const fallbackUrl = "https://example.com/deepseek-pricing";
    const searchHtml = `<html><a href="/url?q=${encodeURIComponent(fallbackUrl)}&sa=U">pricing</a></html>`;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("google.com/search")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => searchHtml,
        };
      }

      if (url.includes("example.com/deepseek-pricing")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => "<html>$0.14 / 1M tokens input $0.28 / 1M tokens</html>",
        };
      }

      return {
        ok: false,
        status: 403,
        headers: new Headers(),
        text: async () => "blocked",
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { refreshPricingSnapshot } = await import("./snapshot");
    const res = await refreshPricingSnapshot({ force: true, providers: ["deepseek"] });

    expect(res.refreshed).toBe(true);
    const deepseek = res.snapshot.sources.find((s) => s.id === "deepseek");
    expect(deepseek).toBeTruthy();
    expect(deepseek?.ok).toBe(true);
    expect(deepseek?.resolved_url).toBe(fallbackUrl);
    expect(deepseek?.notes).toContain("Google search");
    expect((deepseek?.price_signals ?? []).length).toBeGreaterThan(0);
  });
});
