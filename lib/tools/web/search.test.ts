import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/env/config";
import { __resetDdgRateLimitForTests, webSearchTool } from "./search";

const originalTavilyKey = process.env.TAVILY_API_KEY;
const originalProviderOrder = process.env.JARELA_WEB_SEARCH_PROVIDER_ORDER;
const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
const originalGoogleSearchEngineId = process.env.JARELA_GOOGLE_SEARCH_ENGINE_ID;

describe("webSearchTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.env.TAVILY_API_KEY = originalTavilyKey;
    process.env.JARELA_WEB_SEARCH_PROVIDER_ORDER = originalProviderOrder;
    process.env.GOOGLE_API_KEY = originalGoogleApiKey;
    process.env.JARELA_GOOGLE_SEARCH_ENGINE_ID = originalGoogleSearchEngineId;
    __resetDdgRateLimitForTests();
    resetConfigCache();
  });

  it("uses Google Custom Search when configured", async () => {
    delete process.env.TAVILY_API_KEY;
    process.env.GOOGLE_API_KEY = "google-test";
    process.env.JARELA_GOOGLE_SEARCH_ENGINE_ID = "cx-test";
    process.env.JARELA_WEB_SEARCH_PROVIDER_ORDER = "google,duckduckgo";
    resetConfigCache();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              title: "Python",
              link: "https://www.python.org/",
              snippet: "Official Python site.",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const raw = await webSearchTool.invoke({ query: "python", max_results: 5 });
    const data = JSON.parse(String(raw)) as {
      provider: string;
      total: number;
      results: Array<{ url: string }>;
    };

    expect(data.provider).toBe("google");
    expect(data.total).toBe(1);
    expect(data.results[0].url).toBe("https://www.python.org/");
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        href: expect.stringContaining(
          "https://www.googleapis.com/customsearch/v1?",
        ),
      }),
    );
  });

  it("serializes concurrent DuckDuckGo searches behind the global cooldown", async () => {
    delete process.env.TAVILY_API_KEY;
    process.env.JARELA_WEB_SEARCH_PROVIDER_ORDER = "duckduckgo";
    resetConfigCache();
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockDdgSuccess(
      fetchMock,
      "First",
      "https://example.com/first",
      "First result.",
    );
    mockDdgSuccess(
      fetchMock,
      "Second",
      "https://example.com/second",
      "Second result.",
    );

    const first = webSearchTool.invoke({ query: "first", max_results: 5 });
    await Promise.resolve();
    const second = webSearchTool.invoke({ query: "second", max_results: 5 });
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
  it("falls through to DuckDuckGo when Tavily returns no results", async () => {
    process.env.TAVILY_API_KEY = "tvly-test";
    process.env.JARELA_WEB_SEARCH_PROVIDER_ORDER = "tavily,duckduckgo";
    resetConfigCache();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    mockDdgSuccess(
      fetchMock,
      "Python.org",
      "https://www.python.org/",
      "Official Python site.",
      ddgBootstrapUnquotedResponse(),
    );

    const raw = await webSearchTool.invoke({ query: "python", max_results: 5 });
    const data = JSON.parse(String(raw)) as {
      provider: string;
      tried: string[];
      total: number;
      results: Array<{ url: string }>;
    };

    expect(data.provider).toBe("duckduckgo");
    expect(data.tried).toContain("tavily:empty");
    expect(data.total).toBe(1);
    expect(data.results[0].url).toBe("https://www.python.org/");
  });

  it("returns an error instead of empty success when DuckDuckGo is blocked", async () => {
    delete process.env.TAVILY_API_KEY;
    process.env.JARELA_WEB_SEARCH_PROVIDER_ORDER = "duckduckgo";
    resetConfigCache();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("duckduckgo.com/?"))
        return ddgBootstrapResponse();
      return new Response("<html>blocked</html>");
    });

    const raw = await webSearchTool.invoke({ query: "python", max_results: 5 });
    const data = JSON.parse(String(raw)) as {
      error?: string;
      total?: number;
      tried: string[];
      results?: unknown[];
    };

    expect(data.total).toBe(0);
    expect(data.results).toEqual([]);
    expect(data.tried).toContain("duckduckgo:error");
    expect(data.error).toMatch(/no parseable results/i);
  });

  it("normalizes malformed DuckDuckGo responses", async () => {
    delete process.env.TAVILY_API_KEY;
    process.env.JARELA_WEB_SEARCH_PROVIDER_ORDER = "duckduckgo";
    resetConfigCache();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("duckduckgo.com/?"))
        return ddgBootstrapResponse();
      return new Response("<html>not a DDG response</html>");
    });

    const raw = await webSearchTool.invoke({
      query: "site:ica.se erbjudanden ICA vecka",
      max_results: 5,
    });
    const data = JSON.parse(String(raw)) as { error?: string };

    expect(data.error).toMatch(/no parseable results/i);
    expect(data.error).not.toMatch(/reading ['"]1['"]/i);
  });

  it("retries transient DuckDuckGo transport failures", async () => {
    delete process.env.TAVILY_API_KEY;
    process.env.JARELA_WEB_SEARCH_PROVIDER_ORDER = "duckduckgo";
    resetConfigCache();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    mockDdgSuccess(
      fetchMock,
      "Python.org",
      "https://www.python.org/",
      "Official Python site.",
    );

    const raw = await webSearchTool.invoke({ query: "python", max_results: 5 });
    const data = JSON.parse(String(raw)) as { provider: string; total: number };

    expect(data.provider).toBe("duckduckgo");
    expect(data.total).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("falls back to DDG HTML results when d.js is challenged", async () => {
    delete process.env.TAVILY_API_KEY;
    process.env.JARELA_WEB_SEARCH_PROVIDER_ORDER = "duckduckgo";
    resetConfigCache();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(ddgBootstrapResponse())
      .mockResolvedValueOnce(
        new Response("DDG.deep.anomalyDetectionBlock({})", { status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response(
          `
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.wikipedia.org%2F">Wikipedia</a>
        <a class="result__snippet">The free encyclopedia.</a>
      `,
          { status: 200 },
        ),
      );

    const raw = await webSearchTool.invoke({
      query: "Wikipedia",
      max_results: 5,
    });
    const data = JSON.parse(String(raw)) as {
      provider: string;
      total: number;
      results: Array<{ url: string }>;
    };

    expect(data.provider).toBe("duckduckgo");
    expect(data.total).toBe(1);
    expect(data.results[0].url).toBe("https://www.wikipedia.org/");
  });
});

function ddgBootstrapResponse(): Response {
  return new Response('<html><script>vqd="4-12345"</script></html>', {
    status: 200,
  });
}

function ddgBootstrapUnquotedResponse(): Response {
  return new Response("<html><script>vqd=4-12345</script></html>", {
    status: 200,
  });
}

function ddgResultResponse(
  title: string,
  url: string,
  snippet: string,
): Response {
  const body = `DDG.pageLayout.load('d',${JSON.stringify([{ t: title, u: url, a: snippet }])});DDG.duckbar.load('news',{});`;
  return new Response(body, { status: 200 });
}

function mockDdgSuccess(
  fetchMock: ReturnType<typeof vi.spyOn>,
  title: string,
  url: string,
  snippet: string,
  bootstrap = ddgBootstrapResponse(),
): void {
  fetchMock
    .mockResolvedValueOnce(bootstrap)
    .mockResolvedValueOnce(ddgResultResponse(title, url, snippet));
}
