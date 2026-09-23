import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "../packages/langchain-package";
import { errorMessage } from "@/lib/utils/error";
import { getConfig } from "@/lib/env/config";
import { resolveGoogleApiKey } from "@/lib/utils/google-api";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchProviderAdapter {
  readonly id: SearchProvider;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

type SearchProvider = "tavily" | "google" | "duckduckgo";

const SUPPORTED_PROVIDERS = new Set<string>(["tavily", "google", "duckduckgo"]);
const DEFAULT_PROVIDER_ORDER: SearchProvider[] = ["tavily", "google", "duckduckgo"];
const DDG_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/121.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
] as const;
const DDG_RETRY_DELAYS_MS = [400, 900, 1400, 1900] as const;
const DDG_REQUEST_TIMEOUT_MS = 10_000;
const DDG_CHALLENGE_ERROR_RE =
  /anomaly|unexpected response|search token|(?:search|status) 202/i;
const DDG_COMMON_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
} as const;
const DDG_MIN_INTERVAL_MS = 5_000;

let ddgRequestQueue = Promise.resolve();
let ddgNextAllowedAt = 0;

async function withDdgRateLimit<T>(work: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = ddgRequestQueue;
  ddgRequestQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;

  try {
    const waitMs = Math.max(0, ddgNextAllowedAt - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    ddgNextAllowedAt = Date.now() + DDG_MIN_INTERVAL_MS;
    return await work();
  } finally {
    release();
  }
}

/** @internal Test-only reset for the module-scoped DDG scheduler. */
export function __resetDdgRateLimitForTests(): void {
  ddgRequestQueue = Promise.resolve();
  ddgNextAllowedAt = 0;
}

function parseProviderOrder(raw: string): { order: SearchProvider[]; ignored: string[]; usedDefault: boolean } {
  const out: SearchProvider[] = [];
  const ignored: string[] = [];
  const seen = new Set<SearchProvider>();
  for (const token of raw.split(",")) {
    const p = token.trim().toLowerCase();
    if (!p) continue;
    if (!SUPPORTED_PROVIDERS.has(p)) continue;
    const provider = p as SearchProvider;
    if (seen.has(provider)) continue;
    seen.add(provider);
    out.push(provider);
  }
  for (const token of raw.split(",")) {
    const p = token.trim().toLowerCase();
    if (!p) continue;
    if (!SUPPORTED_PROVIDERS.has(p)) ignored.push(p);
  }
  if (out.length > 0) return { order: out, ignored, usedDefault: false };
  return { order: [...DEFAULT_PROVIDER_ORDER], ignored, usedDefault: true };
}

async function googleSearch(query: string, limit: number, apiKey: string, searchEngineId: string): Promise<SearchResult[]> {
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", searchEngineId);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(limit));

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Custom Search ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { items?: Array<{ title?: string; link?: string; snippet?: string }> };
  return (data.items ?? [])
    .slice(0, limit)
    .flatMap((result) => {
      const title = result.title?.trim();
      const url = result.link?.trim();
      if (!title || !url) return [];
      return [{ title, url, snippet: result.snippet?.trim() ?? "" }];
    });
}

// Tavily is the preferred backend for agent-grade search (clean JSON, citations,
// good ranking) but requires an API key. Without one we use the maintained
// DuckDuckGo client, which handles DDG's request and response protocol.
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

async function ddgSearch(query: string, limit: number): Promise<SearchResult[]> {
  return withDdgRateLimit(() => ddgSearchAttempts(query, limit));
}

async function ddgSearchAttempts(query: string, limit: number): Promise<SearchResult[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < DDG_USER_AGENTS.length; attempt++) {
    const userAgent = DDG_USER_AGENTS[attempt];
    try {
      const vqd = await getDdgVqd(query, userAgent);
      try {
        const response = await fetchDdgResults(query, vqd, userAgent);
        return parseDdgResults(response, limit);
      } catch (error) {
        if (isDdgChallenge(error)) {
          return fetchDdgHtmlResults(query, limit, userAgent);
        }
        throw error;
      }
    } catch (error) {
      if (isDdgChallenge(error)) {
        try {
          return await fetchDdgHtmlResults(query, limit, userAgent);
        } catch (fallbackError) {
          lastError = fallbackError;
        }
      } else {
        lastError = error;
      }
      const retryDelay = DDG_RETRY_DELAYS_MS[attempt];
      if (retryDelay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`DuckDuckGo search failed after ${DDG_USER_AGENTS.length} attempts: ${detail}`);
}

function isDdgChallenge(error: unknown): boolean {
  return error instanceof Error && DDG_CHALLENGE_ERROR_RE.test(error.message);
}

async function fetchDdgHtmlResults(query: string, limit: number, userAgent: string): Promise<SearchResult[]> {
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      ...DDG_COMMON_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "https://duckduckgo.com/",
      "User-Agent": userAgent,
    },
    body: `q=${encodeURIComponent(query)}&kl=us-en`,
    signal: AbortSignal.timeout(Math.min(getConfig().httpRequestTimeoutMs, DDG_REQUEST_TIMEOUT_MS)),
  });
  if (!response.ok) throw new Error(`DuckDuckGo HTML search ${response.status}`);
  const html = await response.text();
  const results: SearchResult[] = [];
  const titleRe = /<a\b[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while (results.length < limit && (match = titleRe.exec(html)) !== null) {
    const tagEnd = html.indexOf(">", match.index);
    if (tagEnd < 0) continue;
    const href = /\bhref=["']([^"']+)["']/i.exec(html.slice(match.index, tagEnd + 1))?.[1];
    const url = href ? unwrapDdgHtmlUrl(href) : null;
    if (!url) continue;
    const next = html.slice(match.index + match[0].length);
    const snippet = /<a\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(next)?.[1] ?? "";
    results.push({ title: stripDdgMarkup(match[1]), url, snippet: stripDdgMarkup(snippet) });
  }
  if (results.length === 0) throw new Error("DuckDuckGo returned no parseable results");
  return results;
}

function unwrapDdgHtmlUrl(value: string): string | null {
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (url.hostname.endsWith("duckduckgo.com") && url.pathname === "/l/") {
      return url.searchParams.get("uddg");
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function getDdgVqd(query: string, userAgent: string): Promise<string> {
  const url = new URL("https://duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("ia", "web");
    const response = await fetch(url, {
      headers: { ...DDG_COMMON_HEADERS, "User-Agent": userAgent },
      signal: AbortSignal.timeout(Math.min(getConfig().httpRequestTimeoutMs, DDG_REQUEST_TIMEOUT_MS)),
    });
  if (!response.ok) throw new Error(`DuckDuckGo bootstrap ${response.status}`);
  const html = await response.text();
  const match = /\bvqd\s*(?:["']?\s*[:=]\s*)(?:["']|&quot;)?(\d+-\d+(?:-\d+)?)(?:["']|&quot;)?/i.exec(html);
  if (!match) {
    const contentType = response.headers.get("content-type") ?? "unknown content type";
    const markers = [
      /captcha|challenge|anomaly/i.test(html) ? "challenge" : "",
      /duckduckgo/i.test(html) ? "duckduckgo-page" : "",
    ].filter(Boolean).join(",") || "none";
    throw new Error(
      `DuckDuckGo bootstrap did not return a search token (status=${response.status}, ` +
      `content-type=${contentType}, body-length=${html.length}, markers=${markers})`,
    );
  }
  return match[1];
}

async function fetchDdgResults(query: string, vqd: string, userAgent: string): Promise<string> {
  const url = new URL("https://links.duckduckgo.com/d.js");
  const params: Record<string, string> = {
    q: query,
    t: "D",
    l: "en-us",
    kl: "us-en",
    s: "0",
    dl: "en",
    ct: "US",
    bing_market: "en-US",
    df: "a",
    vqd,
    sp: "1",
    bpa: "1",
    biaexp: "b",
    msvrtexp: "b",
    nadse: "b",
    eclsexp: "b",
    tjsexp: "b",
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      headers: {
        ...DDG_COMMON_HEADERS,
        Accept: "application/javascript,text/javascript,*/*;q=0.8",
        Referer: "https://duckduckgo.com/",
        "User-Agent": userAgent,
      },
      signal: AbortSignal.timeout(Math.min(getConfig().httpRequestTimeoutMs, DDG_REQUEST_TIMEOUT_MS)),
  });
  if (!response.ok) throw new Error(`DuckDuckGo search ${response.status}`);
  const body = await response.text();
    if (/DDG\.deep\.anomalyDetectionBlock/.test(body)) {
    throw new Error("DuckDuckGo detected an anomaly in the request");
  }
  return body;
}

function parseDdgResults(body: string, limit: number): SearchResult[] {
  const marker = "DDG.pageLayout.load('d',";
  const start = body.indexOf(marker);
  if (start < 0) throw new Error("DuckDuckGo returned an unexpected response format");
  const arrayStart = start + marker.length;
  const arrayEnd = findJsonEnd(body, arrayStart);
  const raw = JSON.parse(body.slice(arrayStart, arrayEnd));
  if (!Array.isArray(raw)) throw new Error("DuckDuckGo returned an invalid result list");
  return raw.slice(0, limit).flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const result = item as { t?: string; u?: string; a?: string; n?: unknown };
    if (result.n !== undefined) return [];
    const title = result.t?.trim();
    const url = result.u?.trim();
    if (!title || !url) return [];
    return [{ title, url, snippet: stripDdgMarkup(result.a ?? "") }];
  });
}

function findJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return index + 1;
  }
  throw new Error("DuckDuckGo returned an incomplete result list");
}

function stripDdgMarkup(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function createDuckDuckGoProvider(): SearchProviderAdapter {
  return { id: "duckduckgo", search: ddgSearch };
}

function createTavilyProvider(apiKey: string): SearchProviderAdapter {
  return { id: "tavily", search: (query, limit) => tavilySearch(query, limit, apiKey) };
}

function createGoogleProvider(apiKey: string, searchEngineId: string): SearchProviderAdapter {
  return { id: "google", search: (query, limit) => googleSearch(query, limit, apiKey, searchEngineId) };
}

function resolveGoogleSearchApiKey(): string | null {
  const fromEnv = (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return resolveGoogleApiKey();
  } catch {
    return null;
  }
}

export const webSearchTool = tool(
  async ({ query, max_results }) => {
    const limit = Math.min(max_results ?? 5, 10);
    const tavilyKey = process.env.TAVILY_API_KEY?.trim();
    const config = getConfig();
    const parsedOrder = parseProviderOrder(config.webSearchProviderOrder);
    const googleSearchEngineId = config.googleSearchEngineId;
    const order = parsedOrder.order;
    const tried: string[] = [];
    let lastErr: unknown = null;

    for (const provider of order) {
      if (provider === "tavily" && !tavilyKey) {
        tried.push("tavily:missing_api_key");
        continue;
      }
      if (provider === "google" && !googleSearchEngineId) {
        tried.push("google:missing_search_engine_id");
        continue;
      }
      try {
        const googleApiKey = provider === "google" ? resolveGoogleSearchApiKey() : null;
        if (provider === "google" && !googleApiKey) {
          tried.push("google:missing_api_key");
          continue;
        }
        const adapter = provider === "tavily"
          ? createTavilyProvider(tavilyKey!)
          : provider === "google"
            ? createGoogleProvider(googleApiKey!, googleSearchEngineId)
            : createDuckDuckGoProvider();
        const results = await adapter.search(query, limit);
        if (results.length === 0) {
          tried.push(`${provider}:empty`);
          continue;
        }
        return JSON.stringify({
          query,
          provider,
          provider_order: order,
          ignored_providers: parsedOrder.ignored,
          used_default_order: parsedOrder.usedDefault,
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
      ignored_providers: parsedOrder.ignored,
      used_default_order: parsedOrder.usedDefault,
      tried,
      results: [],
      total: 0,
      error: errorMessage(lastErr ?? new Error("no configured provider returned results")),
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
