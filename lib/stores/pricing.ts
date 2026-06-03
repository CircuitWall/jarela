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
  // Aggregator-agnostic: lookup by model_id alone. Some providers proxy
  // upstream models (github-copilot, openrouter-style aggregators) and
  // don't expose per-model pricing themselves, so we also index every
  // model_rate by its model id. First-write wins; subsequent same-id
  // entries only overwrite when they improve confidence or fill a null.
  byModel: Map<string, ProviderRates>;
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
  const byModel = new Map<string, ProviderRates>();

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
        const entry: ProviderRates = {
          inputPer1M: modelRate.input_per_1m_usd,
          outputPer1M: modelRate.output_per_1m_usd,
          source: source.resolved_url ?? source.pricing_url,
          inferred: modelRate.inferred !== false,
          confidence: modelRate.confidence ?? "low",
          ok: source.ok !== false,
          status: source.status ?? null,
          error: source.error ?? null,
        };
        byProviderModel.set(`${key}::${normalizedModel}`, entry);
        // Aggregator-agnostic index. Prefer entries with actual numbers and
        // higher confidence so that, e.g., anthropic's authoritative rate
        // for `claude-opus-4-7` beats a copilot proxy guess for the same id.
        const existing = byModel.get(normalizedModel);
        if (!existing || isBetterRate(entry, existing)) {
          byModel.set(normalizedModel, entry);
        }
      }
    }
  }

  const tables: PricingTables = {
    byProvider,
    byProviderModel,
    byModel,
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
  if (!modelId) return providerRatesFor(tables, provider);
  const modelKey = modelId.trim().toLowerCase();
  if (!modelKey) return providerRatesFor(tables, provider);

  // 1. Prefer (provider, model_id) when both are known — authoritative.
  if (provider) {
    const providerKey = normalizeProvider(provider);
    if (providerKey) {
      const candidates = modelAliasCandidates(providerKey, modelKey);
      for (const candidate of candidates) {
        const exact = tables.byProviderModel.get(`${providerKey}::${candidate}`);
        if (exact) return exact;
      }

      // github-copilot (and similar aggregators) re-expose upstream models
      // without their own pricing entry. Resolve via the inferred upstream
      // vendor before falling back to plain model lookup.
      if (providerKey === "github-copilot") {
        const upstream = inferProviderFromModelId(modelKey);
        if (upstream) {
          const upstreamCandidates = modelAliasCandidates(upstream, modelKey);
          for (const candidate of upstreamCandidates) {
            const viaUpstreamModel = tables.byProviderModel.get(`${upstream}::${candidate}`);
            if (viaUpstreamModel) return viaUpstreamModel;
          }
          // Upstream had no per-model rate either — try its provider-level
          // rate before falling through to the model-only index.
          const upstreamProviderRate = tables.byProvider.get(upstream);
          if (upstreamProviderRate && upstreamProviderRate.ok) return upstreamProviderRate;
        }
      }
    }
  }

  // 2. Aggregator fallback: lookup by model_id alone. Covers the case where
  //    the user-configured provider doesn't publish per-model pricing but the
  //    same id is rated by its upstream vendor in the snapshot.
  for (const candidate of modelAliasCandidates(provider ? (normalizeProvider(provider) ?? "") : "", modelKey)) {
    const viaModel = tables.byModel.get(candidate);
    if (viaModel) return viaModel;
  }
  const directModel = tables.byModel.get(modelKey);
  if (directModel) return directModel;

  // 3. Provider-level rate (or "no provider assigned" error).
  return providerRatesFor(tables, provider);
}

// Tie-breaker for the byModel index when multiple sources rate the same id.
// Prefer entries that actually have numbers and the higher confidence band.
function isBetterRate(next: ProviderRates, prev: ProviderRates): boolean {
  const nextHas = next.inputPer1M != null || next.outputPer1M != null;
  const prevHas = prev.inputPer1M != null || prev.outputPer1M != null;
  if (nextHas && !prevHas) return true;
  if (!nextHas && prevHas) return false;
  const rank = { high: 2, medium: 1, low: 0 } as const;
  return rank[next.confidence] > rank[prev.confidence];
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
  // Aggregators (OpenRouter, LiteLLM, etc.) namespace upstream models as
  // `vendor/model` or `aggregator/vendor/model`. The snapshot only stores
  // the bare model id, so add the post-`/` suffix as a fallback candidate.
  const slash = id.lastIndexOf("/");
  if (slash >= 0 && slash < id.length - 1) out.add(id.slice(slash + 1));
  if (provider === "deepseek") {
    if (/reasoner/.test(id) || /r1/.test(id)) out.add("deepseek-reasoner");
    if (/chat/.test(id) || /v[0-9]/.test(id) || /coder/.test(id)) out.add("deepseek-chat");
  }
  return [...out];
}

function inferProviderFromModelId(modelId: string): string | null {
  const raw = modelId.trim().toLowerCase();
  if (!raw) return null;
  const slash = raw.lastIndexOf("/");
  const id = slash >= 0 && slash < raw.length - 1 ? raw.slice(slash + 1) : raw;
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
