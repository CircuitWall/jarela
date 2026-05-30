import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SNAPSHOT_PATH = resolve("docs", "journal", "pricing-snapshot.json");
const DEFAULT_TTL_DAYS = 3;

const SOURCES = [
  {
    id: "openai",
    name: "OpenAI",
    pricing_url: "https://openai.com/api/pricing/",
    notes: "Official pricing page (HTML)",
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

export async function refreshPricingSnapshot(opts?: { force?: boolean; ttlDays?: number }): Promise<PricingRefreshResult> {
  const force = opts?.force === true;
  const ttlDays = opts?.ttlDays && Number.isFinite(opts.ttlDays) ? Math.max(1, opts.ttlDays) : DEFAULT_TTL_DAYS;

  const existing = await readPricingSnapshot();
  if (!force && existing) {
    const ageDays = (Date.now() - Date.parse(existing.generated_at)) / (24 * 60 * 60 * 1000);
    if (Number.isFinite(ageDays) && ageDays < ttlDays) {
      return { refreshed: false, reason: "fresh", snapshot: existing };
    }
  }

  const sources: PricingSnapshotSource[] = [];
  for (const source of SOURCES) {
    const row = await fetchSource(source);
    sources.push(row);
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

async function fetchSource(source: (typeof SOURCES)[number]): Promise<PricingSnapshotSource> {
  const fetched_at = new Date().toISOString();
  try {
    const res = await fetch(source.pricing_url, {
      headers: {
        "user-agent": "jarela-pricing-snapshot/2.0 (+dashboard-refresh)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const body = await res.text();
    return {
      ...source,
      fetched_at,
      ok: res.ok,
      status: res.status,
      etag: res.headers.get("etag"),
      last_modified: res.headers.get("last-modified"),
      content_hash: hashContent(body),
      content_length: body.length,
      price_signals: extractPriceSignals(body),
      error: null,
    };
  } catch (error) {
    return {
      ...source,
      fetched_at,
      ok: false,
      status: null,
      etag: null,
      last_modified: null,
      content_hash: null,
      content_length: 0,
      price_signals: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
