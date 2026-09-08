import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/env/config";
import { webSearchTool } from "./search";

const originalTavilyKey = process.env.TAVILY_API_KEY;
const originalProviderOrder = process.env.JARELA_WEB_SEARCH_PROVIDER_ORDER;
const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
const originalGoogleSearchEngineId = process.env.JARELA_GOOGLE_SEARCH_ENGINE_ID;

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function ddgHtml(): string {
  return `
    <div class="result results_links results_links_deep web-result">
      <div class="result__body links_main links_deep result__body--news">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.python.org%2F">Python.org</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.python.org%2F">Official Python site.</a>
      </div>
    </div>
  `;
}

describe("webSearchTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.env.TAVILY_API_KEY = originalTavilyKey;
    process.env.JARELA_WEB_SEARCH_PROVIDER_ORDER = originalProviderOrder;
    process.env.GOOGLE_API_KEY = originalGoogleApiKey;
    process.env.JARELA_GOOGLE_SEARCH_ENGINE_ID = originalGoogleSearchEngineId;
    resetConfigCache();
  });

  it("uses Google Custom Search when configured", async () => {
    delete process.env.TAVILY_API_KEY;
    process.env.GOOGLE_API_KEY = "google-test";
    process.env.JARELA_GOOGLE_SEARCH_ENGINE_ID = "cx-test";
    process.env.JARELA_WEB_SEARCH_PROVIDER_ORDER = "google,duckduckgo";
    resetConfigCache();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      items: [
        { title: "Python", link: "https://www.python.org/", snippet: "Official Python site." },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const raw = await webSearchTool.invoke({ query: "python", max_results: 5 });
    const data = JSON.parse(String(raw)) as { provider: string; total: number; results: Array<{ url: string }> };

    expect(data.provider).toBe("google");
    expect(data.total).toBe(1);
    expect(data.results[0].url).toBe("https://www.python.org/");
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({
      href: expect.stringContaining("https://www.googleapis.com/customsearch/v1?"),
    }));
  });

  it("falls through to DuckDuckGo when Tavily returns no results", async () => {
    process.env.TAVILY_API_KEY = "tvly-test";
    process.env.JARELA_WEB_SEARCH_PROVIDER_ORDER = "tavily,duckduckgo";
    resetConfigCache();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(response(ddgHtml()));

    const raw = await webSearchTool.invoke({ query: "python", max_results: 5 });
    const data = JSON.parse(String(raw)) as { provider: string; tried: string[]; total: number; results: Array<{ url: string }> };

    expect(data.provider).toBe("duckduckgo");
    expect(data.tried).toContain("tavily:empty");
    expect(data.total).toBe(1);
    expect(data.results[0].url).toBe("https://www.python.org/");
  });

  it("returns an error instead of empty success when DuckDuckGo is blocked", async () => {
    delete process.env.TAVILY_API_KEY;
    process.env.JARELA_WEB_SEARCH_PROVIDER_ORDER = "duckduckgo";
    resetConfigCache();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => response("<html>anomaly modal</html>", 202));

    const raw = await webSearchTool.invoke({ query: "python", max_results: 5 });
    const data = JSON.parse(String(raw)) as { error?: string; total?: number; tried: string[]; results?: unknown[] };

    expect(data.total).toBe(0);
    expect(data.results).toEqual([]);
    expect(data.tried).toContain("duckduckgo:error");
    expect(data.error).toMatch(/DuckDuckGo returned 202 anomaly placeholder/i);
  });
});
