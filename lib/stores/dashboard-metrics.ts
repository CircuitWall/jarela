import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { listToolStats, toStats } from "@/lib/stores/tool-stats";
import type { PersistedToolEvent } from "@/lib/stores/threads";

const CHARS_PER_TOKEN = 4;
const DEFAULT_WINDOW_DAYS = 30;

export interface DashboardSeriesPoint {
  day: string;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
  tool_calls: number;
  tool_successes: number;
  tool_errors: number;
  success_rate: number;
  error_rate: number;
}

export interface DashboardToolTop {
  name: string;
  call_count: number;
  success_count: number;
  error_count: number;
  score: number;
  success_rate: number;
  last_called_at: string | null;
}

export interface DashboardAgentTop {
  agent_id: string;
  agent_name: string;
  message_count: number;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
}

export interface DashboardProviderRate {
  provider: string;
  input_per_1m_usd: number | null;
  output_per_1m_usd: number | null;
  source: string;
  ok: boolean;
  status: number | null;
  error: string | null;
}

export interface DashboardModelRate {
  provider: string;
  model_id: string;
  input_per_1m_usd: number | null;
  output_per_1m_usd: number | null;
  source: string;
  ok: boolean;
  status: number | null;
  error: string | null;
}

export interface DashboardProviderBreakdown {
  provider: string;
  message_count: number;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
}

export interface DashboardModelBreakdown {
  model_config_name: string;
  provider: string;
  model_id: string;
  message_count: number;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
}

export interface DashboardMetrics {
  generated_at: string;
  days: number;
  summary: {
    input_tokens_est: number;
    output_tokens_est: number;
    estimated_cost_usd: number;
    tool_calls: number;
    tool_successes: number;
    tool_errors: number;
    success_rate: number;
    error_rate: number;
  };
  series: DashboardSeriesPoint[];
  top_tools: DashboardToolTop[];
  top_agents: DashboardAgentTop[];
  by_provider: DashboardProviderBreakdown[];
  by_model: DashboardModelBreakdown[];
  pricing: {
    snapshot_generated_at: string | null;
    rates: DashboardProviderRate[];
    model_rates: DashboardModelRate[];
    notes: string;
  };
}

type UsageRow = {
  created_at: string;
  role: string;
  content: string;
  tool_events: string | null;
  agent_id: string;
  agent_name: string | null;
  provider: string | null;
  model_id: string | null;
  model_config_name: string | null;
};

type DayBucket = {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  toolCalls: number;
  toolSuccesses: number;
  toolErrors: number;
};

type AgentBucket = {
  agent_id: string;
  agent_name: string;
  message_count: number;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
};

type ProviderBucket = {
  provider: string;
  message_count: number;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
};

type ModelBucket = {
  model_config_name: string;
  provider: string;
  model_id: string;
  message_count: number;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
};

type ProviderRates = {
  inputPer1M: number | null;
  outputPer1M: number | null;
  source: string;
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
  }>;
};

type PricingSnapshot = {
  generated_at?: string;
  sources?: PricingSnapshotSource[];
};

export async function getDashboardMetrics(days = DEFAULT_WINDOW_DAYS): Promise<DashboardMetrics> {
  const now = new Date();
  const boundedDays = Number.isFinite(days) ? Math.min(120, Math.max(7, Math.floor(days))) : DEFAULT_WINDOW_DAYS;
  const since = new Date(now.getTime() - (boundedDays * 24 * 60 * 60 * 1000)).toISOString();

  const usageRows = getDb()
    .prepare(
      `SELECT m.created_at, m.role, m.content, m.tool_events, t.agent_id,
              a.name AS agent_name, mc.provider AS provider,
              mc.model_id AS model_id,
              ta.model_config_name AS model_config_name
         FROM messages m
         JOIN threads t ON t.thread_id = m.thread_id
         LEFT JOIN agent_configs a ON a.id = t.agent_id
         LEFT JOIN task_assignments ta ON ta.agent_id = t.agent_id
         LEFT JOIN model_configs mc ON mc.name = ta.model_config_name
        WHERE m.created_at >= ?
        ORDER BY m.created_at ASC`,
    )
    .all(since) as UsageRow[];

  const { byProvider, byProviderModel, generatedAt } = await loadProviderRates();
  const dayMap = seedDayBuckets(now, boundedDays);
  const agentMap = new Map<string, AgentBucket>();
  const providerMap = new Map<string, ProviderBucket>();
  const modelMap = new Map<string, ModelBucket>();

  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let totalCalls = 0;
  let totalSuccesses = 0;
  let totalErrors = 0;

  for (const row of usageRows) {
    const day = row.created_at.slice(0, 10);
    const dayBucket = dayMap.get(day);
    if (!dayBucket) continue;

    const tokenEstimate = estimateTokens(row.content);
    const isInput = row.role === "user";
    const inputTokens = isInput ? tokenEstimate : 0;
    const outputTokens = isInput ? 0 : tokenEstimate;

    const rates = modelRatesFor(byProvider, byProviderModel, row.provider, row.model_id);
    const estCost = estimateCostUsd(inputTokens, outputTokens, rates);

    dayBucket.inputTokens += inputTokens;
    dayBucket.outputTokens += outputTokens;
    dayBucket.estimatedCost += estCost;

    totalInput += inputTokens;
    totalOutput += outputTokens;
    totalCost += estCost;

    const agentName = row.agent_name?.trim() || row.agent_id;
    const agentBucket = agentMap.get(row.agent_id) ?? {
      agent_id: row.agent_id,
      agent_name: agentName,
      message_count: 0,
      input_tokens_est: 0,
      output_tokens_est: 0,
      estimated_cost_usd: 0,
    };
    agentBucket.message_count += 1;
    agentBucket.input_tokens_est += inputTokens;
    agentBucket.output_tokens_est += outputTokens;
    agentBucket.estimated_cost_usd += estCost;
    agentMap.set(row.agent_id, agentBucket);

    const providerName = row.provider?.trim().toLowerCase() || "unassigned";
    const providerBucket = providerMap.get(providerName) ?? {
      provider: providerName,
      message_count: 0,
      input_tokens_est: 0,
      output_tokens_est: 0,
      estimated_cost_usd: 0,
    };
    providerBucket.message_count += 1;
    providerBucket.input_tokens_est += inputTokens;
    providerBucket.output_tokens_est += outputTokens;
    providerBucket.estimated_cost_usd += estCost;
    providerMap.set(providerName, providerBucket);

    const modelConfigName = row.model_config_name?.trim() || "unassigned";
    const modelId = row.model_id?.trim() || "unknown";
    const modelKey = `${providerName}::${modelConfigName}::${modelId}`;
    const modelBucket = modelMap.get(modelKey) ?? {
      model_config_name: modelConfigName,
      provider: providerName,
      model_id: modelId,
      message_count: 0,
      input_tokens_est: 0,
      output_tokens_est: 0,
      estimated_cost_usd: 0,
    };
    modelBucket.message_count += 1;
    modelBucket.input_tokens_est += inputTokens;
    modelBucket.output_tokens_est += outputTokens;
    modelBucket.estimated_cost_usd += estCost;
    modelMap.set(modelKey, modelBucket);

    if (row.tool_events && row.tool_events.length > 1) {
      const usage = summarizeEvents(row.tool_events);
      if (usage.calls > 0) {
        dayBucket.toolCalls += usage.calls;
        dayBucket.toolSuccesses += usage.successes;
        dayBucket.toolErrors += usage.errors;
        totalCalls += usage.calls;
        totalSuccesses += usage.successes;
        totalErrors += usage.errors;
      }
    }
  }

  const series = [...dayMap.entries()].map(([day, b]) => {
    const successRate = b.toolCalls > 0 ? b.toolSuccesses / b.toolCalls : 1;
    const errorRate = b.toolCalls > 0 ? b.toolErrors / b.toolCalls : 0;
    return {
      day,
      input_tokens_est: b.inputTokens,
      output_tokens_est: b.outputTokens,
      estimated_cost_usd: round4(b.estimatedCost),
      tool_calls: b.toolCalls,
      tool_successes: b.toolSuccesses,
      tool_errors: b.toolErrors,
      success_rate: round4(successRate),
      error_rate: round4(errorRate),
    } satisfies DashboardSeriesPoint;
  });

  const top_tools = listToolStats()
    .map((row) => {
      const stats = toStats(row);
      return {
        name: row.tool_name,
        call_count: row.call_count,
        success_count: row.success_count,
        error_count: row.error_count,
        score: round4(stats.score),
        success_rate: round4(stats.success_rate),
        last_called_at: row.last_called_at,
      } satisfies DashboardToolTop;
    })
    .sort((a, b) => {
      if (b.call_count !== a.call_count) return b.call_count - a.call_count;
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 10);

  const top_agents = [...agentMap.values()]
    .sort((a, b) => {
      if (b.estimated_cost_usd !== a.estimated_cost_usd) return b.estimated_cost_usd - a.estimated_cost_usd;
      if (b.message_count !== a.message_count) return b.message_count - a.message_count;
      return a.agent_name.localeCompare(b.agent_name);
    })
    .slice(0, 8)
    .map((row) => ({
      ...row,
      estimated_cost_usd: round4(row.estimated_cost_usd),
    }));

  const by_provider = [...providerMap.values()]
    .sort((a, b) => {
      if (b.estimated_cost_usd !== a.estimated_cost_usd) return b.estimated_cost_usd - a.estimated_cost_usd;
      if (b.message_count !== a.message_count) return b.message_count - a.message_count;
      return a.provider.localeCompare(b.provider);
    })
    .map((row) => ({
      ...row,
      estimated_cost_usd: round4(row.estimated_cost_usd),
    }));

  const by_model = [...modelMap.values()]
    .sort((a, b) => {
      if (b.estimated_cost_usd !== a.estimated_cost_usd) return b.estimated_cost_usd - a.estimated_cost_usd;
      if (b.message_count !== a.message_count) return b.message_count - a.message_count;
      return a.model_config_name.localeCompare(b.model_config_name);
    })
    .map((row) => ({
      ...row,
      estimated_cost_usd: round4(row.estimated_cost_usd),
    }));

  const overallSuccessRate = totalCalls > 0 ? totalSuccesses / totalCalls : 1;
  const overallErrorRate = totalCalls > 0 ? totalErrors / totalCalls : 0;

  return {
    generated_at: now.toISOString(),
    days: boundedDays,
    summary: {
      input_tokens_est: totalInput,
      output_tokens_est: totalOutput,
      estimated_cost_usd: round4(totalCost),
      tool_calls: totalCalls,
      tool_successes: totalSuccesses,
      tool_errors: totalErrors,
      success_rate: round4(overallSuccessRate),
      error_rate: round4(overallErrorRate),
    },
    series,
    top_tools,
    top_agents,
    by_provider,
    by_model,
    pricing: {
      snapshot_generated_at: generatedAt,
      rates: [...byProvider.entries()]
        .map(([provider, rates]) => ({
          provider,
          input_per_1m_usd: rates.inputPer1M,
          output_per_1m_usd: rates.outputPer1M,
          source: rates.source,
          ok: rates.ok,
          status: rates.status,
          error: rates.error,
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider)),
      model_rates: [...byProviderModel.entries()]
        .map(([key, rates]) => {
          const splitAt = key.indexOf("::");
          const provider = splitAt > -1 ? key.slice(0, splitAt) : key;
          const model_id = splitAt > -1 ? key.slice(splitAt + 2) : "unknown";
          return {
            provider,
            model_id,
            input_per_1m_usd: rates.inputPer1M,
            output_per_1m_usd: rates.outputPer1M,
            source: rates.source,
            ok: rates.ok,
            status: rates.status,
            error: rates.error,
          } satisfies DashboardModelRate;
        })
        .sort((a, b) => {
          if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
          return a.model_id.localeCompare(b.model_id);
        }),
      notes: "Estimated costs are heuristic: token counts are content-length based and rates are inferred from pricing page signals (provider-model first, then provider fallback).",
    },
  };
}

function seedDayBuckets(now: Date, days: number): Map<string, DayBucket> {
  const out = new Map<string, DayBucket>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - (i * 24 * 60 * 60 * 1000));
    const day = d.toISOString().slice(0, 10);
    out.set(day, {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      toolCalls: 0,
      toolSuccesses: 0,
      toolErrors: 0,
    });
  }
  return out;
}

function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / CHARS_PER_TOKEN));
}

function estimateCostUsd(inputTokens: number, outputTokens: number, rates: ProviderRates): number {
  const inputRate = rates.inputPer1M;
  const outputRate = rates.outputPer1M;
  if (inputRate == null && outputRate == null) return 0;
  const inCost = inputRate == null ? 0 : (inputTokens / 1_000_000) * inputRate;
  const outCost = outputRate == null ? 0 : (outputTokens / 1_000_000) * outputRate;
  return inCost + outCost;
}

function providerRatesFor(byProvider: Map<string, ProviderRates>, provider: string | null): ProviderRates {
  if (!provider) return { inputPer1M: null, outputPer1M: null, source: "unknown", ok: false, status: null, error: "no provider assigned" };
  return byProvider.get(provider.toLowerCase())
    ?? { inputPer1M: null, outputPer1M: null, source: "unknown", ok: false, status: null, error: "provider missing in pricing snapshot" };
}

function modelRatesFor(
  byProvider: Map<string, ProviderRates>,
  byProviderModel: Map<string, ProviderRates>,
  provider: string | null,
  modelId: string | null,
): ProviderRates {
  if (!provider || !modelId) {
    return providerRatesFor(byProvider, provider);
  }

  const providerKey = normalizeProvider(provider);
  const modelKey = modelId.trim().toLowerCase();
  if (!providerKey || !modelKey) {
    return providerRatesFor(byProvider, provider);
  }

  const exact = byProviderModel.get(`${providerKey}::${modelKey}`);
  if (exact) return exact;
  return providerRatesFor(byProvider, providerKey);
}

function summarizeEvents(raw: string): { calls: number; successes: number; errors: number } {
  let events: PersistedToolEvent[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) events = parsed as PersistedToolEvent[];
  } catch {
    return { calls: 0, successes: 0, errors: 0 };
  }

  const resultById = new Map<string, boolean>();
  for (const ev of events) {
    if (!ev || ev.phase !== "result") continue;
    const key = ev.id || `${ev.phase}:${ev.name}`;
    resultById.set(key, !isErrorPayload(ev.payload));
  }

  let calls = 0;
  let successes = 0;
  let errors = 0;

  for (const ev of events) {
    if (!ev || ev.phase !== "call") continue;
    calls += 1;
    const key = ev.id || `${ev.phase}:${ev.name}`;
    const ok = resultById.get(key);
    if (ok === true) successes += 1;
    else errors += 1;
  }

  return { calls, successes, errors };
}

function isErrorPayload(payload: unknown): boolean {
  if (typeof payload === "string") return /\berror\b|\bfailed\b|\bexception\b/i.test(payload);
  if (!payload || typeof payload !== "object") return false;
  if ("error" in payload || "errors" in payload) return true;
  const status = "status" in payload ? (payload as { status?: unknown }).status : undefined;
  return typeof status === "string" && /error|failed/i.test(status);
}

async function loadProviderRates(): Promise<{
  byProvider: Map<string, ProviderRates>;
  byProviderModel: Map<string, ProviderRates>;
  generatedAt: string | null;
}> {
  const snapshot = await readPricingSnapshot();
  const out = new Map<string, ProviderRates>();
  const byProviderModel = new Map<string, ProviderRates>();
  const expectedProviders = ["openai", "anthropic", "google", "deepseek", "cohere", "github-copilot"];

  for (const provider of expectedProviders) {
    out.set(provider, {
      inputPer1M: null,
      outputPer1M: null,
      source: "snapshot-missing",
      ok: false,
      status: null,
      error: "provider missing in pricing snapshot",
    });
  }

  if (!snapshot?.sources) {
    return { byProvider: out, byProviderModel, generatedAt: null };
  }

  for (const source of snapshot.sources) {
    const key = normalizeProvider(source.id);
    if (!key) continue;
    const parsed = inferRatesFromSignals(source.price_signals ?? []);
    out.set(key, {
      inputPer1M: parsed.inputPer1M,
      outputPer1M: parsed.outputPer1M,
      source: source.resolved_url ?? source.pricing_url,
      ok: source.ok !== false,
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
        ok: source.ok !== false,
        status: source.status ?? null,
        error: source.error ?? null,
      });
    }
  }

  return { byProvider: out, byProviderModel, generatedAt: snapshot.generated_at ?? null };
}

async function readPricingSnapshot(): Promise<PricingSnapshot | null> {
  try {
    const filePath = join(process.cwd(), "docs", "journal", "pricing-snapshot.json");
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as PricingSnapshot;
  } catch {
    return null;
  }
}

function normalizeProvider(id: string): string | null {
  const lower = id.toLowerCase();
  if (lower.includes("github") || lower.includes("copilot")) return "github-copilot";
  if (lower.includes("google") || lower.includes("gemini")) return "google";
  if (lower.includes("openai")) return "openai";
  if (lower.includes("anthropic")) return "anthropic";
  if (lower.includes("cohere")) return "cohere";
  if (lower.includes("deepseek")) return "deepseek";
  return lower || null;
}

function inferRatesFromSignals(signals: string[]): { inputPer1M: number | null; outputPer1M: number | null } {
  const tokenRates = signals
    .map((s) => {
      const m = /\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/?\s*1M\s*tokens/i.exec(s);
      if (!m) return null;
      return Number(m[1]);
    })
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);

  if (tokenRates.length === 0) return { inputPer1M: null, outputPer1M: null };
  if (tokenRates.length === 1) {
    return {
      inputPer1M: tokenRates[0],
      outputPer1M: tokenRates[0],
    };
  }

  return {
    inputPer1M: tokenRates[0],
    outputPer1M: tokenRates[tokenRates.length - 1],
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
