import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "../packages/langchain-package";
import { errorMessage } from "@/lib/utils/error";
import { getIntegrationRaw } from "@/lib/stores/integrations";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchEngineParser {
  parse(body: string, limit: number): SearchResult[];
}

class FirecrawlJsonParser implements SearchEngineParser {
  parse(body: string, limit: number): SearchResult[] {
    const data = JSON.parse(body) as {
      success?: boolean;
      data?: { web?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (data.data?.web ?? []).slice(0, limit).flatMap((item) => {
      const title = item.title?.trim();
      const url = item.url?.trim();
      return title && url ? [{ title, url, snippet: item.description?.trim() ?? "" }] : [];
    });
  }
}

const FIRECRAWL_PARSER = new FirecrawlJsonParser();
const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const SEARCH_TIMEOUT_MS = 30_000;

function resolveFirecrawlApiKey(): string | null {
  try {
    return getIntegrationRaw("firecrawl")?.api_key?.trim()
      || process.env.FIRECRAWL_API_KEY?.trim()
      || null;
  } catch {
    return process.env.FIRECRAWL_API_KEY?.trim() || null;
  }
}

export const webSearchTool = tool(
  async ({ query, max_results }) => {
    const limit = Math.min(max_results ?? 5, 10);
    try {
      const apiKey = resolveFirecrawlApiKey();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(FIRECRAWL_SEARCH_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, limit, sources: ["web"] }),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Firecrawl Search ${response.status}`);
      const results = FIRECRAWL_PARSER.parse(await response.text(), limit);
      if (results.length === 0) throw new Error("Firecrawl returned no web results");
      return JSON.stringify({ query, engine: "firecrawl", provider: "firecrawl", tried: [], results, total: results.length });
    } catch (error) {
      return JSON.stringify({ query, engine: "firecrawl", provider: "firecrawl", tried: ["firecrawl:error"], results: [], total: 0, error: errorMessage(error) });
    }
  },
  {
    name: "web_search",
    description: "Search the web with Firecrawl Search and return normalized title, URL, and snippet results.",
    schema: z.object({
      query: z.string().describe("Search query"),
      max_results: z.number().int().min(1).max(10).optional().describe("Max results to return (default 5, max 10)"),
    }),
  },
);

registerLangChainPackage({ category: "Web", tools: { read: [webSearchTool] } });
