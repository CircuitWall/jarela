import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "./langchain-package";
import { errorMessage } from "@/lib/utils/error";
import { getConfig } from "@/lib/env/config";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

type SearchProvider = "tavily" | "duckduckgo";

const DEFAULT_PROVIDER_ORDER: SearchProvider[] = ["tavily", "duckduckgo"];

function parseProviderOrder(raw: string): SearchProvider[] {
  const out: SearchProvider[] = [];
  const seen = new Set<SearchProvider>();
  for (const token of raw.split(",")) {
    const p = token.trim().toLowerCase();
    if (p !== "tavily" && p !== "duckduckgo") continue;
    const provider = p as SearchProvider;
    if (seen.has(provider)) continue;
    seen.add(provider);
    out.push(provider);
  }
  return out.length > 0 ? out : [...DEFAULT_PROVIDER_ORDER];
}

// Tavily is the preferred backend for agent-grade search (clean JSON, citations,
// good ranking) but requires an API key. Without one we fall back to scraping
// DuckDuckGo's HTML endpoint — which works without auth and goes through
// EnvHttpProxyAgent on corporate networks.
async function tavilySearch(query: string, limit: number, apiKey: string): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: limit,
      search_depth: "basic",
    }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
  return (data.results ?? []).slice(0, limit).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content ?? "",
  }));
}

// Rotate UA across retries — DDG flags repeated identical fingerprints.
const UA_POOL = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
];

async function ddgSearch(query: string, limit: number): Promise<SearchResult[]> {
  // DDG returns a 202 "anomaly detection" placeholder when it suspects
  // automation. Retry with rotated UAs and exponential backoff. Empty results
  // on a 200 are treated as legitimate "no hits" and not retried.
  let lastStatus = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ua = UA_POOL[attempt % UA_POOL.length];
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": "https://duckduckgo.com/",
      },
      body: `q=${encodeURIComponent(query)}&kl=us-en`,
    });
    lastStatus = res.status;
    if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
    const html = await res.text();
    const parsed = parseDDGHtml(html, limit);
    if (parsed.length > 0) return parsed;
    if (res.status !== 202) return parsed; // genuine empty result on 200
    // Backoff: 400, 900, 1600, 2500 ms — total max ≈ 5.4s
    await new Promise((r) => setTimeout(r, 400 + attempt * 500));
  }
  // All retries returned 202 placeholder — surface as empty so caller can handle.
  console.warn(`[web_search] DDG returned ${lastStatus} placeholder on all attempts for "${query}"`);
  return [];
}

function parseDDGHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Each result block contains a result__a (title link) and a result__snippet (snippet link).
  const blockRe = /<div\s+class="result\s+results_links[^"]*"[\s\S]*?<\/div>\s*<\/div>/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) !== null) {
    if (results.length >= limit) break;
    const block = match[0];
    const titleMatch = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const snippetMatch = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!titleMatch) continue;
    const url = unwrapDDGRedirect(decodeHTML(titleMatch[1]));
    if (!url) continue;
    const title = stripTags(titleMatch[2]).trim();
    const snippet = snippetMatch ? stripTags(snippetMatch[1]).trim() : "";
    if (title) results.push({ title, url, snippet });
  }
  return results;
}

function unwrapDDGRedirect(href: string): string | null {
  // DDG wraps outbound links as //duckduckgo.com/l/?uddg=<encoded>&...
  if (href.startsWith("//")) href = `https:${href}`;
  try {
    const u = new URL(href);
    if (u.hostname.endsWith("duckduckgo.com") && u.pathname === "/l/") {
      const real = u.searchParams.get("uddg");
      return real ? decodeURIComponent(real) : null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeHTML(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export const webSearchTool = tool(
  async ({ query, max_results }) => {
    const limit = Math.min(max_results ?? 5, 10);
    const tavilyKey = process.env.TAVILY_API_KEY?.trim();
    const order = parseProviderOrder(getConfig().webSearchProviderOrder);
    const tried: string[] = [];
    let lastErr: unknown = null;

    for (const provider of order) {
      if (provider === "tavily" && !tavilyKey) {
        tried.push("tavily:missing_api_key");
        continue;
      }
      try {
        const results = provider === "tavily"
          ? await tavilySearch(query, limit, tavilyKey!)
          : await ddgSearch(query, limit);
        return JSON.stringify({
          query,
          provider,
          provider_order: order,
          tried,
          results,
          total: results.length,
        });
      } catch (err) {
        tried.push(`${provider}:error`);
        lastErr = err;
      }
    }

    return JSON.stringify({
      query,
      provider_order: order,
      tried,
      error: errorMessage(lastErr ?? new Error("no configured provider available")),
    });
  },
  {
    name: "web_search",
    description:
      "Search the web and return relevant results (title, url, snippet). " +
      "Best for factual lookups, current events, documentation, and research. " +
      "Returns up to 10 results per call; default 5.",
    schema: z.object({
      query: z.string().describe("Search query"),
      max_results: z.number().optional().describe("Max results to return (default 5, max 10)"),
    }),
  },
);

registerLangChainPackage({
  category: "Web",
  tools: { read: [webSearchTool] },
});
