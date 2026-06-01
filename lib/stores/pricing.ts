// Sync pricing lookups for both write-time cost snapshots (ADR-0041
// `message_usage`) and read-time dashboard aggregation.
//
// The previous live in `lib/stores/dashboard-metrics.ts` was async because
// the dashboard was the only consumer and it loaded the JSON via fs/promises.
// The write path (persistAssistantMessage) needs sync access, so we read
// the snapshot synchronously and cache it in process memory keyed by
// mtime. Refreshing the pricing snapshot on disk invalidates the cache on
// next read.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ProviderRates = {
  inputPer1M: number | null;
  outputPer1M: number | null;
  source: string;
  inferred: boolean;
  confidence: "high" | "medium" | "low";
  ok: boolean;
  status: number | null;
  error: string | null;
};

type PricingSnapshotSource = {
  id: string;
  pricing_url: string;
  resolved_url?: string | null;
  ok?: boolean;
  status?: number | null;
  error?: string | null;
  price_signals?: string[];
  model_rates?: Array<{
    model_id: string;
    input_per_1m_usd: number | null;
    output_per_1m_usd: number | null;
    inferred?: boolean;
    confidence?: "high" | "medium" | "low";
  }>;
};

type PricingSnapshot = {
  generated_at?: string;
  sources?: PricingSnapshotSource[];
};

export interface PricingTables {
  byProvider: Map<string, ProviderRates>;
  byProviderModel: Map<string, ProviderRates>;
  generatedAt: string | null;
}

const EXPECTED_PROVIDERS = ["openai", "anthropic", "google", "deepseek", "cohere", "github-copilot"];

let cached: { mtimeMs: number; tables: PricingTables } | null = null;

function snapshotPath(): string {
  return join(process.cwd(), "docs", "journal", "pricing-snapshot.json");
}

function readSnapshotSync(): { snapshot: PricingSnapshot | null; mtimeMs: number } {
  try {
    const p = snapshotPath();
    const stat = statSync(p);
    const raw = readFileSync(p, "utf8");
    return { snapshot: JSON.parse(raw) as PricingSnapshot, mtimeMs: stat.mtimeMs };
  } catch {
    return { snapshot: null, mtimeMs: 0 };
  }
}

export function getPricingTables(): PricingTables {
  const { snapshot, mtimeMs } = readSnapshotSync();
  if (cached && cached.mtimeMs === mtimeMs) return cached.tables;

  const byProvider = new Map<string, ProviderRates>();
  const byProviderModel = new Map<string, ProviderRates>();

  for (const provider of EXPECTED_PROVIDERS) {
    byProvider.set(provider, {
      inputPer1M: null,
      outputPer1M: null,
      source: "snapshot-missing",
      inferred: true,
      confidence: "low",
      ok: false,
      status: null,
      error: "provider missing in pricing snapshot",
    });
  }

  if (snapshot?.sources) {
    for (const source of snapshot.sources) {
      const key = normalizeProvider(source.id);
      if (!key) continue;
      const parsed = inferRatesFromSignals(source.price_signals ?? []);
      const modelInputRates = (source.model_rates ?? [])
        .map((m) => m.input_per_1m_usd)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b);
      const modelOutputRates = (source.model_rates ?? [])
        .map((m) => m.output_per_1m_usd)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b);

      const providerInput = parsed.inputPer1M ?? (modelInputRates[0] ?? null);
      const providerOutput = parsed.outputPer1M ?? (modelOutputRates[0] ?? null);
      const providerDerivedFromModels = parsed.inputPer1M == null && parsed.outputPer1M == null
        && (providerInput != null || providerOutput != null);

      byProvider.set(key, {
        inputPer1M: providerInput,
        outputPer1M: providerOutput,
        source: source.resolved_url ?? source.pricing_url,
        inferred: providerDerivedFromModels ? true : parsed.inferred,
        confidence: providerDerivedFromModels ? "medium" : parsed.confidence,
        ok: source.ok !== false || providerDerivedFromModels,
        status: source.status ?? null,
        error: source.error ?? null,
      });

      for (const modelRate of source.model_rates ?? []) {
        const normalizedModel = modelRate.model_id?.trim().toLowerCase();
        if (!normalizedModel) continue;
        byProviderModel.set(`${key}::${normalizedModel}`, {
          inputPer1M: modelRate.input_per_1m_usd,
          outputPer1M: modelRate.output_per_1m_usd,
          source: source.resolved_url ?? source.pricing_url,
          inferred: modelRate.inferred !== false,
          confidence: modelRate.confidence ?? "low",
          ok: source.ok !== false,
          status: source.status ?? null,
          error: source.error ?? null,
        });
      }
    }
  }

  const tables: PricingTables = {
    byProvider,
    byProviderModel,
    generatedAt: snapshot?.generated_at ?? null,
  };
  cached = { mtimeMs, tables };
  return tables;
}

export function providerRatesFor(tables: PricingTables, provider: string | null): ProviderRates {
  if (!provider) {
    return {
      inputPer1M: null, outputPer1M: null, source: "unknown",
      inferred: true, confidence: "low", ok: false, status: null,
      error: "no provider assigned",
    };
  }
  return tables.byProvider.get(provider.toLowerCase()) ?? {
    inputPer1M: null, outputPer1M: null, source: "unknown",
    inferred: true, confidence: "low", ok: false, status: null,
    error: "provider missing in pricing snapshot",
  };
}

export function modelRatesFor(
  tables: PricingTables,
  provider: string | null,
  modelId: string | null,
): ProviderRates {
  if (!provider || !modelId) return providerRatesFor(tables, provider);
  const providerKey = normalizeProvider(provider);
  const modelKey = modelId.trim().toLowerCase();
  if (!providerKey || !modelKey) return providerRatesFor(tables, provider);

  const candidates = modelAliasCandidates(providerKey, modelKey);
  for (const candidate of candidates) {
    const exact = tables.byProviderModel.get(`${providerKey}::${candidate}`);
    if (exact) return exact;
  }

  if (providerKey === "github-copilot") {
    const upstream = inferProviderFromModelId(modelKey);
    if (upstream) {
      const upstreamCandidates = modelAliasCandidates(upstream, modelKey);
      for (const candidate of upstreamCandidates) {
        const viaUpstreamModel = tables.byProviderModel.get(`${upstream}::${candidate}`);
        if (viaUpstreamModel) return viaUpstreamModel;
      }
      return providerRatesFor(tables, upstream);
    }
  }
  return providerRatesFor(tables, providerKey);
}

export function normalizeProvider(id: string): string | null {
  const lower = id.toLowerCase();
  if (lower.includes("github") || lower.includes("copilot")) return "github-copilot";
  if (lower.includes("google") || lower.includes("gemini")) return "google";
  if (lower.includes("openai")) return "openai";
  if (lower.includes("anthropic")) return "anthropic";
  if (lower.includes("cohere")) return "cohere";
  if (lower.includes("deepseek")) return "deepseek";
  return lower || null;
}

function modelAliasCandidates(provider: string, modelId: string): string[] {
  const out = new Set<string>();
  const id = modelId.trim().toLowerCase();
  if (!id) return [];
  out.add(id);
  if (provider === "deepseek") {
    if (/reasoner/.test(id) || /r1/.test(id)) out.add("deepseek-reasoner");
    if (/chat/.test(id) || /v[0-9]/.test(id) || /coder/.test(id)) out.add("deepseek-chat");
  }
  return [...out];
}

function inferProviderFromModelId(modelId: string): string | null {
  const id = modelId.trim().toLowerCase();
  if (!id) return null;
  if (id.startsWith("gpt-") || /^o[1-4](?:-|$)/.test(id)) return "openai";
  if (id.startsWith("claude-")) return "anthropic";
  if (id.startsWith("gemini-")) return "google";
  if (id.startsWith("deepseek-")) return "deepseek";
  if (id.startsWith("command-") || id.startsWith("embed-")) return "cohere";
  return null;
}

function inferRatesFromSignals(signals: string[]): {
  inputPer1M: number | null;
  outputPer1M: number | null;
  inferred: boolean;
  confidence: "high" | "medium" | "low";
} {
  const tokenRates = signals
    .map((s) => {
      const m = /\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/?\s*(?:1M\s*tokens|M\s*Tok|MTok)/i.exec(s);
      if (!m) return null;
      return Number(m[1]);
    })
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (tokenRates.length === 0) {
    return { inputPer1M: null, outputPer1M: null, inferred: true, confidence: "low" };
  }
  return {
    inputPer1M: tokenRates[0],
    outputPer1M: tokenRates[tokenRates.length - 1],
    inferred: true,
    confidence: tokenRates.length >= 2 ? "medium" : "low",
  };
}

export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  rates: Pick<ProviderRates, "inputPer1M" | "outputPer1M">,
): number {
  const inputRate = rates.inputPer1M;
  const outputRate = rates.outputPer1M;
  if (inputRate == null && outputRate == null) return 0;
  const inCost = inputRate == null ? 0 : (inputTokens / 1_000_000) * inputRate;
  const outCost = outputRate == null ? 0 : (outputTokens / 1_000_000) * outputRate;
  return inCost + outCost;
}
