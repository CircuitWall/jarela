import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SNAPSHOT_PATH = resolve("docs", "journal", "pricing-snapshot.json");
const DEFAULT_TTL_DAYS = 3;

interface SourceDef {
  id: string;
  name: string;
  pricing_url: string;
  notes: string;
  fallback_urls?: string[];
}

const SOURCES: SourceDef[] = [
  {
    id: "openai",
    name: "OpenAI",
    pricing_url: "https://openai.com/api/pricing/",
    notes: "Official pricing page (HTML)",
    fallback_urls: [
      "https://platform.openai.com/docs/pricing",
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    pricing_url: "https://www.anthropic.com/pricing",
    notes: "Official pricing page (HTML)",
  },
  {
    id: "google-gemini",
    name: "Google Gemini",
    pricing_url: "https://ai.google.dev/gemini-api/docs/pricing",
    notes: "Official pricing docs page (HTML)",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    pricing_url: "https://platform.deepseek.com/pricing",
    notes: "Official pricing page (HTML)",
    fallback_urls: [
      "https://api-docs.deepseek.com/quick_start/pricing",
    ],
  },
  {
    id: "cohere",
    name: "Cohere",
    pricing_url: "https://cohere.com/pricing",
    notes: "Official pricing page (HTML)",
  },
] as const;

const PRICE_LINE_RE = new RegExp(
  [
    String.raw`\$\s*\d+(?:\.\d+)?\s*(?:/|per)\s*(?:1\s*[MK]|million|thousand)?\s*(?:input|output)?\s*(?:tokens?|chars?)`,
    String.raw`(?:input|output)\s*\$\s*\d+(?:\.\d+)?\s*(?:/|per)\s*(?:1\s*[MK]|million|thousand)?\s*(?:tokens?|chars?)`,
    String.raw`\$\s*\d+(?:\.\d+)?\s*(?:/|per)\s*(?:image|minute|request)`,
  ].join("|"),
  "gi",
);

export interface PricingSnapshotSource {
  id: string;
  name: string;
  pricing_url: string;
  resolved_url?: string | null;
  notes: string;
  fetched_at: string;
  ok: boolean;
  status: number | null;
  etag: string | null;
  last_modified: string | null;
  content_hash: string | null;
  content_length: number;
  price_signals: string[];
  error: string | null;
}

export interface PricingSnapshot {
  generated_at: string;
  disclaimer: string;
  ttl_days: number;
  sources: PricingSnapshotSource[];
}

export interface PricingRefreshResult {
  refreshed: boolean;
  reason: "forced" | "stale" | "missing" | "fresh";
  snapshot: PricingSnapshot;
}

function toCanonicalProvider(id: string): string {
  const lower = id.toLowerCase();
  if (lower.includes("google") || lower.includes("gemini")) return "google";
  if (lower.includes("openai")) return "openai";
  if (lower.includes("anthropic")) return "anthropic";
  if (lower.includes("deepseek")) return "deepseek";
  if (lower.includes("cohere")) return "cohere";
  return lower;
}

function sortSourcesByKnownOrder(sources: PricingSnapshotSource[]): PricingSnapshotSource[] {
  const order = new Map(SOURCES.map((s, i) => [s.id, i]));
  return [...sources].sort((a, b) => {
    const ai = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bi = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.id.localeCompare(b.id);
  });
}

export async function refreshPricingSnapshot(opts?: { force?: boolean; ttlDays?: number; providers?: string[] }): Promise<PricingRefreshResult> {
  const force = opts?.force === true;
  const ttlDays = opts?.ttlDays && Number.isFinite(opts.ttlDays) ? Math.max(1, opts.ttlDays) : DEFAULT_TTL_DAYS;
  const providerFilter = new Set((opts?.providers ?? [])
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map(toCanonicalProvider));

  const existing = await readPricingSnapshot();
  if (!force && existing) {
    const ageDays = (Date.now() - Date.parse(existing.generated_at)) / (24 * 60 * 60 * 1000);
    if (Number.isFinite(ageDays) && ageDays < ttlDays) {
      return { refreshed: false, reason: "fresh", snapshot: existing };
    }
  }

  const selected = providerFilter.size > 0
    ? SOURCES.filter((s) => providerFilter.has(toCanonicalProvider(s.id)))
    : SOURCES;

  const fetched: PricingSnapshotSource[] = [];
  for (const source of selected) {
    const row = await fetchSource(source);
    fetched.push(row);
  }

  let sources: PricingSnapshotSource[] = fetched;
  if (providerFilter.size > 0 && existing?.sources?.length) {
    const untouched = existing.sources.filter((s) => !providerFilter.has(toCanonicalProvider(s.id)));
    sources = sortSourcesByKnownOrder([...fetched, ...untouched]);
  }

  const snapshot: PricingSnapshot = {
    generated_at: new Date().toISOString(),
    disclaimer: "No unified stable pricing API exists across providers. Verify final pricing manually on each official page.",
    ttl_days: ttlDays,
    sources,
  };

  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
  await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  return {
    refreshed: true,
    reason: force ? "forced" : (existing ? "stale" : "missing"),
    snapshot,
  };
}

async function readPricingSnapshot(): Promise<PricingSnapshot | null> {
  try {
    const raw = await readFile(SNAPSHOT_PATH, "utf8");
    return JSON.parse(raw) as PricingSnapshot;
  } catch {
    return null;
  }
}

function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function extractPriceSignals(html: string): string[] {
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const hits = plain.match(PRICE_LINE_RE) ?? [];
  const normalized = [...new Set(hits.map((s) => s.trim()))];
  return normalized.slice(0, 40);
}

async function fetchSource(source: SourceDef): Promise<PricingSnapshotSource> {
  const fetched_at = new Date().toISOString();
  const urls = [source.pricing_url, ...(source.fallback_urls ?? [])];
  let lastError: string | null = null;
  let lastStatus: number | null = null;
  let lastBody = "";
  let resolved_url: string | null = null;

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": "jarela-pricing-snapshot/2.1 (+dashboard-refresh)",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          referer: "https://github.com/circuitwall/jarela",
        },
      });

      const body = await res.text();
      lastStatus = res.status;
      lastBody = body;

      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }

      resolved_url = url;
      return {
        id: source.id,
        name: source.name,
        pricing_url: source.pricing_url,
        resolved_url,
        notes: source.notes,
        fetched_at,
        ok: true,
        status: res.status,
        etag: res.headers.get("etag"),
        last_modified: res.headers.get("last-modified"),
        content_hash: hashContent(body),
        content_length: body.length,
        price_signals: extractPriceSignals(body),
        error: null,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    id: source.id,
    name: source.name,
    pricing_url: source.pricing_url,
    resolved_url,
    notes: source.notes,
    fetched_at,
    ok: false,
    status: lastStatus,
    etag: null,
    last_modified: null,
    content_hash: lastBody ? hashContent(lastBody) : null,
    content_length: lastBody.length,
    price_signals: lastBody ? extractPriceSignals(lastBody) : [],
    error: lastError,
  };
}
