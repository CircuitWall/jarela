import { afterEach, describe, expect, it, vi } from "vitest";
import { webSearchTool } from "./search";

const originalFirecrawlKey = process.env.FIRECRAWL_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  process.env.FIRECRAWL_API_KEY = originalFirecrawlKey;
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
