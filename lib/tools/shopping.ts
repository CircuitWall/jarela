import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { stripHtml } from "@/lib/utils/html";
import { registerLangChainPackage } from "./langchain-package";
import { webSearchTool } from "./search";
import { errorMessage } from "@/lib/utils/error";

type ShoppingProvider = "prisjakt";

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface PrisjaktProduct {
  source: "prisjakt";
  country: "SE";
  currency: "SEK";
  title: string;
  product_url: string;
  category: string | null;
  min_price: number | null;
  rating: number | null;
  merchant_count: number | null;
  matched_specs: string[];
  score: number;
  snippet: string;
}

const COUNTRY_CONFIG = {
  SE: {
    displayName: "Sweden",
    currency: "SEK" as const,
    prisjaktHost: "www.prisjakt.nu",
  },
} as const;

function normalizeCountry(country: string): keyof typeof COUNTRY_CONFIG | null {
  const c = country.trim().toUpperCase();
  return c in COUNTRY_CONFIG ? (c as keyof typeof COUNTRY_CONFIG) : null;
}

function buildPrisjaktQuery(
  country: keyof typeof COUNTRY_CONFIG,
  productName: string,
  productCategory?: string,
  specs?: Record<string, string>,
): string {
  const cfg = COUNTRY_CONFIG[country];
  const parts = [productName.trim()];
  if (productCategory?.trim()) parts.push(productCategory.trim());
  for (const value of Object.values(specs ?? {})) {
    const v = String(value).trim();
    if (v) parts.push(v);
  }
  parts.push(`site:${cfg.prisjaktHost}`);
  parts.push("produkt");
  return parts.join(" ");
}

function looksLikePrisjaktProductUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith("prisjakt.nu") && u.pathname.startsWith("/produkt.php");
  } catch {
    return false;
  }
}

function normalizeSpaces(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function parseSekPrice(input: string): number | null {
  const cleaned = input
    .replace(/\u00a0/g, " ")
    .replace(/kr/gi, "")
    .replace(/\s+/g, "")
    .replace(/,/g, ".");
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseMinPrice(text: string): number | null {
  const direct = /Det billigaste priset[^.]*?är\s+([\d\s.,]+)\s*kr/i.exec(text);
  if (direct?.[1]) return parseSekPrice(direct[1]);
  const from = /\bfr\.\s*([\d\s.,]+)\s*kr/i.exec(text);
  if (from?.[1]) return parseSekPrice(from[1]);
  return null;
}

function parseMerchantCount(text: string): number | null {
  const total = /totalt\s+(\d+)\s+butiker/i.exec(text);
  if (total?.[1]) return Number.parseInt(total[1], 10);
  const from = /fr[åa]n\s+(\d+)\s+butiker/i.exec(text);
  if (from?.[1]) return Number.parseInt(from[1], 10);
  const plus = /\+(\d+)\s+butiker/i.exec(text);
  if (plus?.[1]) return Number.parseInt(plus[1], 10);
  return null;
}

function parseRating(text: string): number | null {
  const m = /(\d(?:[.,]\d)?)\s+av\s+5\s+stjärnor/i.exec(text);
  if (!m?.[1]) return null;
  const rating = Number.parseFloat(m[1].replace(",", "."));
  return Number.isFinite(rating) ? rating : null;
}

function parseCategory(text: string): string | null {
  const m = /Kategori\s+([^\n\r]+?)\s+(?:Serie|Skärmstorlek|5G|Varumärke|Produktnamn)/i.exec(text);
  if (!m?.[1]) return null;
  const category = normalizeSpaces(m[1]);
  return category || null;
}

function scoreProduct(
  index: number,
  title: string,
  snippet: string,
  category: string | null,
  wantedCategory?: string,
  matchedSpecs: string[] = [],
  totalSpecs: number = 0,
): number {
  let score = 1 / (index + 1);
  const haystack = `${title} ${snippet}`.toLowerCase();
  if (wantedCategory?.trim()) {
    const wanted = wantedCategory.trim().toLowerCase();
    if (haystack.includes(wanted) || category?.toLowerCase().includes(wanted)) {
      score += 0.8;
    }
  }
  if (totalSpecs > 0) score += (matchedSpecs.length / totalSpecs) * 1.2;
  return Number(score.toFixed(4));
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }
  const html = await res.text();
  return stripHtml(html, { preserveParagraphs: true });
}

async function runWebSearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const raw = await webSearchTool.invoke({ query, max_results: Math.min(Math.max(maxResults, 3), 10) });
  const parsed = JSON.parse(raw) as {
    error?: string;
    results?: Array<{ title?: string; url?: string; snippet?: string }>;
  };
  if (parsed.error) throw new Error(parsed.error);
  return (parsed.results ?? [])
    .filter((r): r is { title: string; url: string; snippet: string } => !!r.title && !!r.url)
    .map((r) => ({ title: r.title, url: r.url, snippet: r.snippet ?? "" }));
}

function matchedSpecs(text: string, specs?: Record<string, string>): string[] {
  if (!specs) return [];
  const hay = text.toLowerCase();
  const matches: string[] = [];
  for (const [key, value] of Object.entries(specs)) {
    const wanted = String(value).trim().toLowerCase();
    if (!wanted) continue;
    if (hay.includes(wanted)) matches.push(key);
  }
  return matches;
}

async function searchPrisjakt(
  country: "SE",
  productName: string,
  productCategory?: string,
  specs?: Record<string, string>,
  maxResults: number = 5,
): Promise<PrisjaktProduct[]> {
  const query = buildPrisjaktQuery(country, productName, productCategory, specs);
  const rawResults = await runWebSearch(query, Math.min(maxResults * 2, 10));
  const candidates = rawResults.filter((r) => looksLikePrisjaktProductUrl(r.url));
  const uniqueUrls = Array.from(new Set(candidates.map((c) => c.url))).slice(0, maxResults);
  const specCount = Object.keys(specs ?? {}).length;

  const products = await Promise.all(
    uniqueUrls.map(async (url, index) => {
      const fromSearch = candidates.find((c) => c.url === url);
      if (!fromSearch) return null;
      let text = `${fromSearch.title}\n${fromSearch.snippet}`;
      try {
        text = `${text}\n${await fetchText(url)}`;
      } catch {
        // Keep partial result from search snippets when product page fetch fails.
      }
      const compact = normalizeSpaces(text);
      const foundSpecs = matchedSpecs(compact, specs);
      const category = parseCategory(text);
      const score = scoreProduct(
        index,
        fromSearch.title,
        fromSearch.snippet,
        category,
        productCategory,
        foundSpecs,
        specCount,
      );

      const product: PrisjaktProduct = {
        source: "prisjakt",
        country,
        currency: COUNTRY_CONFIG[country].currency,
        title: normalizeSpaces(fromSearch.title),
        product_url: url,
        category,
        min_price: parseMinPrice(text),
        rating: parseRating(text),
        merchant_count: parseMerchantCount(text),
        matched_specs: foundSpecs,
        score,
        snippet: normalizeSpaces(fromSearch.snippet),
      };
      return product;
    }),
  );

  return products
    .filter((p): p is PrisjaktProduct => p !== null)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.min_price != null && b.min_price != null) return a.min_price - b.min_price;
      if (a.min_price != null) return -1;
      if (b.min_price != null) return 1;
      return 0;
    })
    .slice(0, maxResults);
}

export const shoppingSearchTool = tool(
  async ({
    provider,
    country,
    product_name,
    product_category,
    specs,
    max_results,
  }) => {
    try {
      const normalizedCountry = normalizeCountry(country);
      if (!normalizedCountry) {
        return JSON.stringify({
          ok: false,
          error: `Unsupported country '${country}'. Supported countries: ${Object.keys(COUNTRY_CONFIG).join(", ")}.`,
          provider,
        });
      }
      if (provider !== "prisjakt") {
        return JSON.stringify({
          ok: false,
          error: `Unsupported provider '${provider}'. Supported providers: prisjakt.`,
        });
      }

      const products = await searchPrisjakt(
        normalizedCountry,
        product_name,
        product_category,
        specs,
        max_results,
      );

      return JSON.stringify({
        ok: true,
        provider,
        country: normalizedCountry,
        country_name: COUNTRY_CONFIG[normalizedCountry].displayName,
        currency: COUNTRY_CONFIG[normalizedCountry].currency,
        query: {
          product_name,
          product_category: product_category ?? null,
          specs: specs ?? {},
        },
        total: products.length,
        results: products,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        provider,
        country,
        error: errorMessage(err),
      });
    }
  },
  {
    name: "shopping_search",
    description:
      "Search shopping products with adapter-backed normalization. " +
      "V1 provider is Prisjakt (Sweden) and supports filtering by country, product name, category, and specs.",
    schema: z.object({
      provider: z.enum(["prisjakt"]).default("prisjakt").describe("Shopping data provider."),
      country: z.string().default("SE").describe("Country code (ISO-like). V1 supports SE."),
      product_name: z.string().describe("Primary product name, model, or keyword to search."),
      product_category: z.string().optional().describe("Optional category hint, e.g. 'mobiltelefoner' or 'hörlurar'."),
      specs: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional structured specs to match, e.g. { ram: '8GB', storage: '256GB', color: 'black' }."),
      max_results: z.number().int().min(1).max(10).default(5).describe("Maximum number of products to return (1-10)."),
    }),
  },
);

registerLangChainPackage({
  category: "Web",
  tools: { read: [shoppingSearchTool] },
});

export const _shoppingInternals = {
  normalizeCountry,
  buildPrisjaktQuery,
  looksLikePrisjaktProductUrl,
  parseSekPrice,
  parseMinPrice,
  parseMerchantCount,
  parseRating,
  parseCategory,
};
