import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/stores/integrations", () => ({
  getIntegrationRaw: vi.fn(() => null),
}));

import { getIntegrationRaw } from "@/lib/stores/integrations";
import { webSearchTool } from "./search";

const originalFirecrawlKey = process.env.FIRECRAWL_API_KEY;
const originalDeepSeekModelKey = process.env.DEEPSEEK_API_KEY;
const integrationLookup = vi.mocked(getIntegrationRaw);

beforeEach(() => {
  integrationLookup.mockReset();
  integrationLookup.mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv("FIRECRAWL_API_KEY", originalFirecrawlKey);
  restoreEnv("DEEPSEEK_API_KEY", originalDeepSeekModelKey);
});

describe("webSearchTool", () => {
  it("calls Firecrawl v2 search and normalizes web results", async () => {
    process.env.FIRECRAWL_API_KEY = "fc-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: { web: [{ title: "TypeScript", url: "https://www.typescriptlang.org/", description: "Docs" }] },
    }), { status: 200 }));

    const data = parse(await webSearchTool.invoke({ query: "TypeScript", max_results: 5 }));
    expect(data).toMatchObject({ engine: "firecrawl", provider: "firecrawl", total: 1 });
    expect(data.results[0]).toMatchObject({ title: "TypeScript", url: "https://www.typescriptlang.org/", snippet: "Docs" });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.firecrawl.dev/v2/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer fc-test" }),
        body: JSON.stringify({ query: "TypeScript", limit: 5, sources: ["web"] }),
      }),
    );
  });

  it("uses DeepSeek only when the separate web credential is configured", async () => {
    integrationLookup.mockImplementation((name) => name === "deepseek-web" ? { api_key: "configured-web-key" } : null);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{
        title: "DeepSeek docs",
        url: "https://api-docs.deepseek.com/",
        snippet: "Search API",
        summary: "Search and Fetch documentation",
      }],
    }), { status: 200 }));

    const data = parse(await webSearchTool.invoke({ query: "DeepSeek docs", max_results: 3 }));
    expect(data).toMatchObject({ engine: "deepseek", provider: "deepseek", total: 1 });
    expect(data.results[0]).toMatchObject({
      title: "DeepSeek docs",
      url: "https://api-docs.deepseek.com/",
      snippet: "Search API",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.deepseek.com/v1/tools/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer configured-web-key" }),
        body: JSON.stringify({ query: "DeepSeek docs", count: 3, need_content: false }),
      }),
    );
    expect(integrationLookup).toHaveBeenCalledWith("deepseek-web");
  });

  it("does not opt into DeepSeek from the chat-model credential", async () => {
    process.env.DEEPSEEK_API_KEY = "model-chat-key";
    process.env.FIRECRAWL_API_KEY = "fc-test";
    integrationLookup.mockImplementation((name) => name === "deepseek" ? { api_key: "model-chat-key" } : null);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: { web: [{ title: "Current backend", url: "https://example.com/", description: "Firecrawl" }] },
    }), { status: 200 }));

    const data = parse(await webSearchTool.invoke({ query: "test" }));
    expect(data.engine).toBe("firecrawl");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.firecrawl.dev/v2/search",
      expect.any(Object),
    );
    expect(fetch).not.toHaveBeenCalledWith(
      "https://api.deepseek.com/v1/tools/search",
      expect.any(Object),
    );
  });

  it("rejects queries outside DeepSeek's documented limit without making a request", async () => {
    integrationLookup.mockImplementation((name) => name === "deepseek-web" ? { api_key: "configured-web-key" } : null);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const data = parse(await webSearchTool.invoke({ query: "x".repeat(129) }));
    expect(data.error).toMatch(/1 to 128 characters/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces DeepSeek billing errors without falling back to Firecrawl", async () => {
    integrationLookup.mockImplementation((name) => name === "deepseek-web" ? { api_key: "configured-web-key" } : null);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("provider error", { status: 402 }));

    const data = parse(await webSearchTool.invoke({ query: "test" }));
    expect(data.provider).toBe("deepseek");
    expect(data.error).toMatch(/insufficient balance/i);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.deepseek.com/v1/tools/search",
      expect.any(Object),
    );
  });

  it("returns an empty search as a valid non-billable result", async () => {
    integrationLookup.mockReturnValue({ api_key: "configured-web-key" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    const data = parse(await webSearchTool.invoke({ query: "no matches" }));
    expect(data).toMatchObject({ provider: "deepseek", results: [], total: 0 });
    expect(data.error).toBeUndefined();
  });

  it("bounds returned results and uses a summary when the snippet is empty", async () => {
    integrationLookup.mockReturnValue({ api_key: "configured-web-key" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      results: Array.from({ length: 5 }, (_, index) => ({
        title: `Source ${index}`,
        url: `https://example.com/${index}`,
        snippet: " ",
        summary: "Readable summary",
      })),
    })));
    const data = parse(await webSearchTool.invoke({ query: "test", max_results: 2 }));
    expect(data.total).toBe(2);
    expect(data.results).toHaveLength(2);
    expect(data.results[0].snippet).toBe("Readable summary");
  });

  it.each([
    { results: [{ title: "Bad link", url: "javascript:alert(1)" }] },
    { results: "invalid" },
  ])("rejects invalid DeepSeek result contracts", async (body) => {
    integrationLookup.mockReturnValue({ api_key: "configured-web-key" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body)));
    const data = parse(await webSearchTool.invoke({ query: "test" }));
    expect(data.error).toMatch(/invalid response/i);
    expect(data.results).toEqual([]);
  });

  it("accepts 128 Unicode characters, and rejects blank input", async () => {
    integrationLookup.mockReturnValue({ api_key: "configured-web-key" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    const data = parse(await webSearchTool.invoke({ query: "\u{1F600}".repeat(128) }));
    expect(data.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const blank = parse(await webSearchTool.invoke({ query: "   " }));
    expect(blank.error).toMatch(/1 to 128/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a useful error when Firecrawl has no results", async () => {
    process.env.FIRECRAWL_API_KEY = "fc-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200 }));
    const data = parse(await webSearchTool.invoke({ query: "nothing", max_results: 5 }));
    expect(data.total).toBe(0);
    expect(data.error).toMatch(/no web results/i);
  });
});

function parse(raw: string): {
  engine: string;
  provider: string;
  total: number;
  results: Array<{ title: string; url: string; snippet: string }>;
  error?: string;
} {
  return JSON.parse(raw) as ReturnType<typeof parse>;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
