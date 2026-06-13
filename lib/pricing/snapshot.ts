import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { llmExtractModelRates, type LlmModelRate } from "./llm-extract";
import { getConfig } from "@/lib/env/config";

const SNAPSHOT_PATH = resolve("docs", "journal", "pricing-snapshot.json");
const DEFAULT_TTL_DAYS = 3;

interface SourceDef {
  id: string;
  name: string;
  pricing_url: string;
  notes: string;
  fallback_urls?: string[];
  search_queries?: string[];
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
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    pricing_url: "https://github.com/features/copilot/plans",
    notes: "GitHub Copilot plans page (HTML)",
    fallback_urls: [
      "https://github.com/marketplace/models/pricing",
      "https://docs.github.com/en/billing/concepts/product-billing/github-models",
    ],
    search_queries: [
      "GitHub Copilot pricing",
      "GitHub Models pricing per token",
    ],
  },
] as const;

const PRICE_LINE_RE = new RegExp(
  [
    String.raw`\$\s*\d+(?:\.\d+)?\s*(?:/|per)\s*(?:1\s*[MK]|million|thousand)?\s*(?:input|output)?\s*(?:tokens?|chars?)`,
    String.raw`\$\s*\d+(?:\.\d+)?\s*(?:/|per)\s*(?:M\s*Tok|MTok)`,
    String.raw`(?:input|output)\s*\$\s*\d+(?:\.\d+)?\s*(?:/|per)\s*(?:1\s*[MK]|million|thousand)?\s*(?:tokens?|chars?)`,
    String.raw`(?:input|output)\s*\$\s*\d+(?:\.\d+)?\s*(?:/|per)\s*(?:M\s*Tok|MTok)`,
    String.raw`(?:1\s*[MK]|million|thousand)\s*(?:input|output)?\s*(?:tokens?|chars?)[^$]{0,48}\$\s*\d+(?:\.\d+)?`,
    String.raw`\$\s*\d+(?:\.\d+)?\s*(?:/|per)\s*(?:image|minute|request)`,
  ].join("|"),
  "gi",
);

const GOOGLE_RESULT_RE = /href="\/url\?q=([^"&]+)[^"]*"/gi;

type FetchAttempt = {
  url: string;
  ok: boolean;
  status: number | null;
  body: string;
  etag: string | null;
  last_modified: string | null;
  error: string | null;
};

type ModelPricingRate = {
  model_id: string;
  input_per_1m_usd: number | null;
  output_per_1m_usd: number | null;
  inferred: boolean;
  confidence: "high" | "medium" | "low";
};

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
  model_rates?: ModelPricingRate[];
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
  if (lower.includes("github") || lower.includes("copilot")) return "github-copilot";
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

function extractPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPriceSignals(html: string): string[] {
  const plain = extractPlainText(html);

  const hits = plain.match(PRICE_LINE_RE) ?? [];
  const normalized = [...new Set(hits.map((s) => s.trim()))];
  return normalized.slice(0, 40);
}

function inferRatePair(text: string): {
  inputPer1M: number | null;
  outputPer1M: number | null;
  inferred: boolean;
  confidence: "high" | "medium" | "low";
} | null {
  const labeledInput = /input[^$]{0,72}\$\s*([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  const labeledOutput = /output[^$]{0,72}\$\s*([0-9]+(?:\.[0-9]+)?)/i.exec(text);

  const inputL = labeledInput ? Number(labeledInput[1]) : null;
  const outputL = labeledOutput ? Number(labeledOutput[1]) : null;

  const tokenRates = [...text.matchAll(/(?:\$\s*([0-9]+(?:\.[0-9]+)?)\s*(?:\/|per)\s*(?:(?:1\s*[MK]|million|thousand)\s*tokens?|M\s*Tok|MTok))|(?:(?:1\s*[MK]|million|thousand)\s*(?:input|output)?\s*tokens?[^$]{0,72}\$\s*([0-9]+(?:\.[0-9]+)?))/gi)]
    .map((m) => Number((m[1] ?? m[2] ?? "").trim()))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);

  const inputPer1M = inputL ?? (tokenRates.length > 0 ? tokenRates[0] : null);
  const outputPer1M = outputL ?? (tokenRates.length > 1 ? tokenRates[tokenRates.length - 1] : inputPer1M);

  if (inputPer1M == null && outputPer1M == null) return null;
  const hasExplicitInOut = inputL != null && outputL != null;
  const inferred = !hasExplicitInOut;
  const confidence: "high" | "medium" | "low" = hasExplicitInOut
    ? "high"
    : (tokenRates.length >= 2 ? "medium" : "low");
  return { inputPer1M, outputPer1M, inferred, confidence };
}

function modelRegexForSource(sourceId: string): RegExp {
  const p = toCanonicalProvider(sourceId);
  if (p === "openai") return /\b(gpt-[a-z0-9.-]+|o[1-4](?:-[a-z0-9.-]+)?)\b/gi;
  if (p === "anthropic") return /\b(claude-[a-z0-9.-]+)\b/gi;
  if (p === "google") return /\b(gemini-[a-z0-9.-]+)\b/gi;
  if (p === "deepseek") return /\b(deepseek-[a-z0-9.-]+)\b/gi;
  if (p === "cohere") return /\b(command-[a-z0-9.-]+|embed-[a-z0-9.-]+)\b/gi;
  if (p === "github-copilot") return /\b(gpt-[a-z0-9.-]+|o[1-4](?:-[a-z0-9.-]+)?|claude-[a-z0-9.-]+|gemini-[a-z0-9.-]+)\b/gi;
  return /\b([a-z][a-z0-9.-]{2,})\b/gi;
}

function extractModelRates(sourceId: string, html: string): ModelPricingRate[] {
  const plain = extractPlainText(html);
  const re = modelRegexForSource(sourceId);
  const byModel = new Map<string, ModelPricingRate>();

  let m: RegExpExecArray | null;
  while ((m = re.exec(plain)) !== null) {
    const modelId = (m[1] ?? "").trim().toLowerCase();
    if (!modelId) continue;

    const idx = m.index ?? 0;
    const start = Math.max(0, idx - 240);
    const end = Math.min(plain.length, idx + 240);
    const window = plain.slice(start, end);
    const pair = inferRatePair(window);
    if (!pair) continue;

    const existing = byModel.get(modelId);
    if (!existing) {
      byModel.set(modelId, {
        model_id: modelId,
        input_per_1m_usd: pair.inputPer1M,
        output_per_1m_usd: pair.outputPer1M,
        inferred: pair.inferred,
        confidence: pair.confidence,
      });
      continue;
    }

    byModel.set(modelId, {
      model_id: modelId,
      input_per_1m_usd: existing.input_per_1m_usd ?? pair.inputPer1M,
      output_per_1m_usd: existing.output_per_1m_usd ?? pair.outputPer1M,
      inferred: existing.inferred && pair.inferred,
      confidence: existing.confidence === "high" || pair.confidence === "high"
        ? "high"
        : (existing.confidence === "medium" || pair.confidence === "medium" ? "medium" : "low"),
    });
  }

  return [...byModel.values()].slice(0, 80);
}

function buildGoogleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function parseGoogleResultLinks(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  let m: RegExpExecArray | null;
  while ((m = GOOGLE_RESULT_RE.exec(html)) !== null) {
    const raw = m[1] ?? "";
    let url = "";
    try {
      url = decodeURIComponent(raw);
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(url)) continue;
    if (/\/google\./i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= 8) break;
  }

  return out;
}

async function fetchHtml(url: string): Promise<FetchAttempt> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "jarela-pricing-snapshot/2.2 (+dashboard-refresh)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        referer: "https://github.com/circuitwall/jarela",
      },
    });

    const body = await res.text();
    return {
      url,
      ok: res.ok,
      status: res.status,
      body,
      etag: res.headers.get("etag"),
      last_modified: res.headers.get("last-modified"),
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: null,
      body: "",
      etag: null,
      last_modified: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function safeLlmExtract(
  source: SourceDef,
  resolvedUrl: string,
  html: string,
): Promise<LlmModelRate[] | null> {
  if (!getConfig().pricingLlmExtract) return null;
  try {
    return await llmExtractModelRates({
      sourceId: source.id,
      sourceName: source.name,
      resolvedUrl,
      html,
    });
  } catch {
    return null;
  }
}

function mergeModelRates(
  regex: ModelPricingRate[],
  llm: LlmModelRate[] | null,
): ModelPricingRate[] {
  if (!llm || llm.length === 0) return regex;
  const merged = new Map<string, ModelPricingRate>();
  for (const row of regex) merged.set(row.model_id, row);
  // LLM wins per model_id: its confidence ladder is stricter (prompt-enforced)
  // and it can read context the regex window misses. Regex rows for models
  // the LLM didn't return stay as a safety net.
  for (const row of llm) merged.set(row.model_id, row);
  return [...merged.values()].slice(0, 100);
}

function noteWithExtractor(base: string, llm: LlmModelRate[] | null): string {
  if (!llm) return base;
  return `${base}; LLM-extracted (${llm.length} model${llm.length === 1 ? "" : "s"})`;
}

async function fetchSource(source: SourceDef): Promise<PricingSnapshotSource> {
  const fetched_at = new Date().toISOString();
  const urls = [source.pricing_url, ...(source.fallback_urls ?? [])];
  const attempted: FetchAttempt[] = [];
  let best: FetchAttempt | null = null;

  const remember = (attempt: FetchAttempt) => {
    attempted.push(attempt);
    if (!best) {
      best = attempt;
      return;
    }
    if (attempt.ok && !best.ok) {
      best = attempt;
      return;
    }
    if (attempt.ok === best.ok && (attempt.body.length > best.body.length)) {
      best = attempt;
    }
  };

  for (const url of urls) {
    const attempt = await fetchHtml(url);
    remember(attempt);
    if (!attempt.ok) continue;
    const signals = extractPriceSignals(attempt.body);
    const regexRates = extractModelRates(source.id, attempt.body);
    const llmRates = await safeLlmExtract(source, attempt.url, attempt.body);
    const modelRates = mergeModelRates(regexRates, llmRates);
    if (signals.length > 0 || modelRates.length > 0) {
      return {
        id: source.id,
        name: source.name,
        pricing_url: source.pricing_url,
        resolved_url: attempt.url,
        notes: noteWithExtractor(source.notes, llmRates),
        fetched_at,
        ok: true,
        status: attempt.status,
        etag: attempt.etag,
        last_modified: attempt.last_modified,
        content_hash: hashContent(attempt.body),
        content_length: attempt.body.length,
        price_signals: signals,
        model_rates: modelRates,
        error: null,
      };
    }
  }

  const searchQueries = source.search_queries && source.search_queries.length > 0
    ? source.search_queries
    : [
      `${source.name} API pricing per 1M tokens`,
      `${source.name} model pricing`,
    ];

  const candidateUrls: string[] = [];
  const seenCandidates = new Set<string>();

  for (const q of searchQueries) {
    const searchAttempt = await fetchHtml(buildGoogleSearchUrl(q));
    remember(searchAttempt);
    if (!searchAttempt.ok || !searchAttempt.body) continue;
    const links = parseGoogleResultLinks(searchAttempt.body);
    for (const link of links) {
      if (seenCandidates.has(link)) continue;
      seenCandidates.add(link);
      candidateUrls.push(link);
      if (candidateUrls.length >= 6) break;
    }
    if (candidateUrls.length >= 6) break;
  }

  for (const url of candidateUrls.slice(0, 3)) {
    const attempt = await fetchHtml(url);
    remember(attempt);
    if (!attempt.ok) continue;
    const signals = extractPriceSignals(attempt.body);
    const regexRates = extractModelRates(source.id, attempt.body);
    const llmRates = await safeLlmExtract(source, attempt.url, attempt.body);
    const modelRates = mergeModelRates(regexRates, llmRates);
    if (signals.length > 0 || modelRates.length > 0) {
      return {
        id: source.id,
        name: source.name,
        pricing_url: source.pricing_url,
        resolved_url: attempt.url,
        notes: `${noteWithExtractor(source.notes, llmRates)}; fallback via Google search`,
        fetched_at,
        ok: true,
        status: attempt.status,
        etag: attempt.etag,
        last_modified: attempt.last_modified,
        content_hash: hashContent(attempt.body),
        content_length: attempt.body.length,
        price_signals: signals,
        model_rates: modelRates,
        error: null,
      };
    }
  }

  const fallback = best ?? {
    url: source.pricing_url,
    ok: false,
    status: null,
    body: "",
    etag: null,
    last_modified: null,
    error: "no fetch attempts completed",
  };

  return {
    id: source.id,
    name: source.name,
    pricing_url: source.pricing_url,
    resolved_url: fallback.url,
    notes: source.notes,
    fetched_at,
    ok: false,
    status: fallback.status,
    etag: null,
    last_modified: null,
    content_hash: fallback.body ? hashContent(fallback.body) : null,
    content_length: fallback.body.length,
    price_signals: fallback.body ? extractPriceSignals(fallback.body) : [],
    model_rates: fallback.body ? extractModelRates(source.id, fallback.body) : [],
    error: fallback.error,
  };
}
