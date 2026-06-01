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
  inferred: boolean;
  confidence: "high" | "medium" | "low";
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
  inferred: boolean;
  confidence: "high" | "medium" | "low";
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

export interface DashboardDayBreakdown {
  day: string;
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
  top_agents: DashboardAgentTop[];
  by_provider: DashboardProviderBreakdown[];
  by_model: DashboardModelBreakdown[];
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
  breakdowns_by_day: Record<string, DashboardDayBreakdown>;
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
  thread_id: string;
  agent_id: string;
  agent_name: string | null;
  provider: string | null;
  model_id: string | null;
  model_config_name: string | null;
  // ADR-0041: when present, these snapshotted values are authoritative
  // for this assistant turn. Provider/model/agent_name override the JOIN.
  mu_input_tokens: number | null;
  mu_output_tokens: number | null;
  mu_cost_usd: number | null;
  mu_provider: string | null;
  mu_model_id: string | null;
  mu_model_config_name: string | null;
  mu_agent_id: string | null;
  mu_agent_name: string | null;
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

export async function getDashboardMetrics(days = DEFAULT_WINDOW_DAYS): Promise<DashboardMetrics> {
  const now = new Date();
  const boundedDays = Number.isFinite(days) ? Math.min(120, Math.max(7, Math.floor(days))) : DEFAULT_WINDOW_DAYS;
  const since = new Date(now.getTime() - (boundedDays * 24 * 60 * 60 * 1000)).toISOString();

  const usageRows = getDb()
    .prepare(
      `SELECT m.created_at, m.role, m.content, m.tool_events, m.thread_id, t.agent_id,
              a.name AS agent_name, mc.provider AS provider,
              mc.model_id AS model_id,
                  COALESCE(ta.model_config_name, a.model_config_name, dmc.name) AS model_config_name,
              mu.input_tokens     AS mu_input_tokens,
              mu.output_tokens    AS mu_output_tokens,
              mu.cost_usd         AS mu_cost_usd,
              mu.provider         AS mu_provider,
              mu.model_id         AS mu_model_id,
              mu.model_config_name AS mu_model_config_name,
              mu.agent_id         AS mu_agent_id,
              mu.agent_name       AS mu_agent_name
         FROM messages m
         JOIN threads t ON t.thread_id = m.thread_id
         LEFT JOIN agent_configs a ON a.id = t.agent_id
         LEFT JOIN task_assignments ta ON ta.agent_id = t.agent_id
         LEFT JOIN model_configs dmc ON dmc.name = (
           SELECT name
           FROM model_configs
           WHERE is_default = 1
           ORDER BY updated_at DESC
           LIMIT 1
         )
         LEFT JOIN model_configs mc ON mc.name = COALESCE(ta.model_config_name, a.model_config_name, dmc.name)
         LEFT JOIN message_usage mu ON mu.message_id = m.msg_id
        WHERE m.created_at >= ?
        ORDER BY m.created_at ASC`,
    )
    .all(since) as UsageRow[];

  // ADR-0041: when an assistant turn has a snapshot, its `input_tokens`
  // already accounts for the entire prompt the model saw — so we must NOT
  // also count this thread's user messages via the content-length estimate
  // or we double-count. Track which threads have any snapshot in the
  // window and suppress their user-side estimates wholesale. Threads with
  // zero snapshots (legacy data, or recorded before the migration) fall
  // back to the old estimate path unchanged.
  const snapshotThreadIds = new Set<string>();
  for (const r of usageRows) {
    // A row with provider tokens (input_tokens > 0) is the authoritative
    // count the dashboard cares about. Snapshot-only rows persisted for
    // the per-tier context-usage bar carry input_tokens=0 + cost_usd=null
    // and must NOT suppress the content-length estimate for that thread.
    if (r.mu_input_tokens != null && r.mu_input_tokens > 0) {
      snapshotThreadIds.add(r.thread_id);
    }
  }

  const { byProvider, byProviderModel, byModel, generatedAt } = await loadProviderRates();
  const dayMap = seedDayBuckets(now, boundedDays);
  const agentMap = new Map<string, AgentBucket>();
  const providerMap = new Map<string, ProviderBucket>();
  const modelMap = new Map<string, ModelBucket>();
  // Per-day breakdown maps. Populated lazily — only days that saw traffic
  // get an entry. Each entry mirrors the global agent/provider/model maps
  // but scoped to that day so the UI can re-slice when a day is selected.
  type DayBreakdownBucket = {
    agents: Map<string, AgentBucket>;
    providers: Map<string, ProviderBucket>;
    models: Map<string, ModelBucket>;
  };
  const dayBreakdownMap = new Map<string, DayBreakdownBucket>();
  const ensureDayBreakdown = (day: string): DayBreakdownBucket => {
    let entry = dayBreakdownMap.get(day);
    if (!entry) {
      entry = { agents: new Map(), providers: new Map(), models: new Map() };
      dayBreakdownMap.set(day, entry);
    }
    return entry;
  };

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

    // ADR-0041: prefer snapshot when present. Snapshot rows are
    // authoritative for tokens, $, AND attribution (provider/model/agent
    // name) for that assistant turn — they survive reassignment, rename,
    // and pricing-snapshot refresh.
    const hasSnapshot = row.mu_input_tokens != null;
    const threadHasSnapshot = snapshotThreadIds.has(row.thread_id);

    let inputTokens = 0;
    let outputTokens = 0;
    let estCost = 0;
    let attribProvider: string | null = row.provider;
    let attribModelId: string | null = row.model_id;
    let attribModelConfig: string | null = row.model_config_name;
    let attribAgentId: string = row.agent_id;
    let attribAgentName: string | null = row.agent_name;

    if (hasSnapshot) {
      inputTokens = row.mu_input_tokens ?? 0;
      outputTokens = row.mu_output_tokens ?? 0;
      estCost = row.mu_cost_usd ?? 0;
      attribProvider = row.mu_provider ?? attribProvider;
      attribModelId = row.mu_model_id ?? attribModelId;
      attribModelConfig = row.mu_model_config_name ?? attribModelConfig;
      attribAgentId = row.mu_agent_id ?? attribAgentId;
      attribAgentName = row.mu_agent_name ?? attribAgentName;
    } else if (row.role === "user" && threadHasSnapshot) {
      // Suppressed: snapshotted assistant turns in this thread already
      // capture this user message's tokens in their input_tokens.
      // Still contributes message_count via the rest of the loop.
    } else {
      const tokenEstimate = estimateTokens(row.content);
      const isInput = row.role === "user";
      inputTokens = isInput ? tokenEstimate : 0;
      outputTokens = isInput ? 0 : tokenEstimate;
      const rates = modelRatesFor(byProvider, byProviderModel, byModel, row.provider, row.model_id);
      estCost = estimateCostUsd(inputTokens, outputTokens, rates);
    }

    dayBucket.inputTokens += inputTokens;
    dayBucket.outputTokens += outputTokens;
    dayBucket.estimatedCost += estCost;

    totalInput += inputTokens;
    totalOutput += outputTokens;
    totalCost += estCost;

    const agentName = attribAgentName?.trim() || attribAgentId;
    const agentBucket = agentMap.get(attribAgentId) ?? {
      agent_id: attribAgentId,
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
    agentMap.set(attribAgentId, agentBucket);

    const providerName = attribProvider?.trim().toLowerCase() || "unassigned";
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

    const modelConfigName = attribModelConfig?.trim() || "unassigned";
    const modelId = attribModelId?.trim() || "unknown";
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

    const dayBreakdown = ensureDayBreakdown(day);
    const dayAgent = dayBreakdown.agents.get(attribAgentId) ?? {
      agent_id: attribAgentId,
      agent_name: agentName,
      message_count: 0,
      input_tokens_est: 0,
      output_tokens_est: 0,
      estimated_cost_usd: 0,
    };
    dayAgent.message_count += 1;
    dayAgent.input_tokens_est += inputTokens;
    dayAgent.output_tokens_est += outputTokens;
    dayAgent.estimated_cost_usd += estCost;
    dayBreakdown.agents.set(attribAgentId, dayAgent);

    const dayProvider = dayBreakdown.providers.get(providerName) ?? {
      provider: providerName,
      message_count: 0,
      input_tokens_est: 0,
      output_tokens_est: 0,
      estimated_cost_usd: 0,
    };
    dayProvider.message_count += 1;
    dayProvider.input_tokens_est += inputTokens;
    dayProvider.output_tokens_est += outputTokens;
    dayProvider.estimated_cost_usd += estCost;
    dayBreakdown.providers.set(providerName, dayProvider);

    const dayModel = dayBreakdown.models.get(modelKey) ?? {
      model_config_name: modelConfigName,
      provider: providerName,
      model_id: modelId,
      message_count: 0,
      input_tokens_est: 0,
      output_tokens_est: 0,
      estimated_cost_usd: 0,
    };
    dayModel.message_count += 1;
    dayModel.input_tokens_est += inputTokens;
    dayModel.output_tokens_est += outputTokens;
    dayModel.estimated_cost_usd += estCost;
    dayBreakdown.models.set(modelKey, dayModel);

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
      estimated_cost_usd: b.estimatedCost,
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
      estimated_cost_usd: row.estimated_cost_usd,
    }));

  const by_provider = [...providerMap.values()]
    .sort((a, b) => {
      if (b.estimated_cost_usd !== a.estimated_cost_usd) return b.estimated_cost_usd - a.estimated_cost_usd;
      if (b.message_count !== a.message_count) return b.message_count - a.message_count;
      return a.provider.localeCompare(b.provider);
    })
    .map((row) => ({
      ...row,
      estimated_cost_usd: row.estimated_cost_usd,
    }));

  const by_model = [...modelMap.values()]
    .sort((a, b) => {
      if (b.estimated_cost_usd !== a.estimated_cost_usd) return b.estimated_cost_usd - a.estimated_cost_usd;
      if (b.message_count !== a.message_count) return b.message_count - a.message_count;
      return a.model_config_name.localeCompare(b.model_config_name);
    })
    .map((row) => ({
      ...row,
      estimated_cost_usd: row.estimated_cost_usd,
    }));

  const overallSuccessRate = totalCalls > 0 ? totalSuccesses / totalCalls : 1;
  const overallErrorRate = totalCalls > 0 ? totalErrors / totalCalls : 0;

  const seriesByDay = new Map(series.map((s) => [s.day, s]));
  const breakdowns_by_day: Record<string, DashboardDayBreakdown> = {};
  for (const [day, bucket] of dayBreakdownMap.entries()) {
    const dayPoint = seriesByDay.get(day);
    const dayAgents = [...bucket.agents.values()]
      .sort((a, b) => {
        if (b.estimated_cost_usd !== a.estimated_cost_usd) return b.estimated_cost_usd - a.estimated_cost_usd;
        if (b.message_count !== a.message_count) return b.message_count - a.message_count;
        return a.agent_name.localeCompare(b.agent_name);
      })
      .slice(0, 8);
    const dayProviders = [...bucket.providers.values()].sort((a, b) => {
      if (b.estimated_cost_usd !== a.estimated_cost_usd) return b.estimated_cost_usd - a.estimated_cost_usd;
      if (b.message_count !== a.message_count) return b.message_count - a.message_count;
      return a.provider.localeCompare(b.provider);
    });
    const dayModels = [...bucket.models.values()].sort((a, b) => {
      if (b.estimated_cost_usd !== a.estimated_cost_usd) return b.estimated_cost_usd - a.estimated_cost_usd;
      if (b.message_count !== a.message_count) return b.message_count - a.message_count;
      return a.model_config_name.localeCompare(b.model_config_name);
    });
    breakdowns_by_day[day] = {
      day,
      summary: {
        input_tokens_est: dayPoint?.input_tokens_est ?? 0,
        output_tokens_est: dayPoint?.output_tokens_est ?? 0,
        estimated_cost_usd: dayPoint?.estimated_cost_usd ?? 0,
        tool_calls: dayPoint?.tool_calls ?? 0,
        tool_successes: dayPoint?.tool_successes ?? 0,
        tool_errors: dayPoint?.tool_errors ?? 0,
        success_rate: dayPoint?.success_rate ?? 1,
        error_rate: dayPoint?.error_rate ?? 0,
      },
      top_agents: dayAgents,
      by_provider: dayProviders,
      by_model: dayModels,
    };
  }

  return {
    generated_at: now.toISOString(),
    days: boundedDays,
    summary: {
      input_tokens_est: totalInput,
      output_tokens_est: totalOutput,
      estimated_cost_usd: totalCost,
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
    breakdowns_by_day,
    pricing: {
      snapshot_generated_at: generatedAt,
      rates: [...byProvider.entries()]
        .map(([provider, rates]) => ({
          provider,
          input_per_1m_usd: rates.inputPer1M,
          output_per_1m_usd: rates.outputPer1M,
          source: rates.source,
          inferred: rates.inferred,
          confidence: rates.confidence,
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
            inferred: rates.inferred,
            confidence: rates.confidence,
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
  if (!provider) return { inputPer1M: null, outputPer1M: null, source: "unknown", inferred: true, confidence: "low", ok: false, status: null, error: "no provider assigned" };
  return byProvider.get(provider.toLowerCase())
    ?? { inputPer1M: null, outputPer1M: null, source: "unknown", inferred: true, confidence: "low", ok: false, status: null, error: "provider missing in pricing snapshot" };
}

function modelRatesFor(
  byProvider: Map<string, ProviderRates>,
  byProviderModel: Map<string, ProviderRates>,
  byModel: Map<string, ProviderRates>,
  provider: string | null,
  modelId: string | null,
): ProviderRates {
  if (!modelId) {
    return providerRatesFor(byProvider, provider);
  }
  const modelKey = modelId.trim().toLowerCase();
  if (!modelKey) return providerRatesFor(byProvider, provider);

  // 1. Prefer (provider, model_id) when both are present.
  if (provider) {
    const providerKey = normalizeProvider(provider);
    if (providerKey) {
      const candidates = modelAliasCandidates(providerKey, modelKey);
      for (const candidate of candidates) {
        const exact = byProviderModel.get(`${providerKey}::${candidate}`);
        if (exact) return exact;
      }
      // GitHub Copilot model configs proxy multiple upstream providers.
      // If no direct copilot model rate exists, fall back to the upstream
      // provider/model inferred from the model id.
      if (providerKey === "github-copilot") {
        const upstream = inferProviderFromModelId(modelKey);
        if (upstream) {
          const upstreamCandidates = modelAliasCandidates(upstream, modelKey);
          for (const candidate of upstreamCandidates) {
            const viaUpstreamModel = byProviderModel.get(`${upstream}::${candidate}`);
            if (viaUpstreamModel) return viaUpstreamModel;
          }
          const upstreamProviderRate = byProvider.get(upstream);
          if (upstreamProviderRate && upstreamProviderRate.ok) return upstreamProviderRate;
        }
      }
    }
  }

  // 2. Aggregator-agnostic fallback: lookup by model_id alone. Covers
  //    cases where the configured provider doesn't publish per-model
  //    pricing but the same model id is rated by its upstream vendor.
  for (const candidate of modelAliasCandidates(provider ? (normalizeProvider(provider) ?? "") : "", modelKey)) {
    const viaModel = byModel.get(candidate);
    if (viaModel) return viaModel;
  }
  const directModel = byModel.get(modelKey);
  if (directModel) return directModel;

  return providerRatesFor(byProvider, provider);
}

function modelAliasCandidates(provider: string, modelId: string): string[] {
  const out = new Set<string>();
  const id = modelId.trim().toLowerCase();
  if (!id) return [];
  out.add(id);

  if (provider === "deepseek") {
    if (/reasoner/.test(id) || /r1/.test(id)) {
      out.add("deepseek-reasoner");
    }
    if (/chat/.test(id) || /v[0-9]/.test(id) || /coder/.test(id)) {
      out.add("deepseek-chat");
    }
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
  byModel: Map<string, ProviderRates>;
  generatedAt: string | null;
}> {
  const snapshot = await readPricingSnapshot();
  const out = new Map<string, ProviderRates>();
  const byProviderModel = new Map<string, ProviderRates>();
  const byModel = new Map<string, ProviderRates>();
  const expectedProviders = ["openai", "anthropic", "google", "deepseek", "cohere", "github-copilot"];

  for (const provider of expectedProviders) {
    out.set(provider, {
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

  if (!snapshot?.sources) {
    return { byProvider: out, byProviderModel, byModel, generatedAt: null };
  }

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

    out.set(key, {
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
      const existing = byModel.get(normalizedModel);
      if (!existing || isBetterRate(entry, existing)) {
        byModel.set(normalizedModel, entry);
      }
    }
  }

  return { byProvider: out, byProviderModel, byModel, generatedAt: snapshot.generated_at ?? null };
}

function isBetterRate(next: ProviderRates, prev: ProviderRates): boolean {
  const nextHas = next.inputPer1M != null || next.outputPer1M != null;
  const prevHas = prev.inputPer1M != null || prev.outputPer1M != null;
  if (nextHas && !prevHas) return true;
  if (!nextHas && prevHas) return false;
  const rank = { high: 2, medium: 1, low: 0 } as const;
  return rank[next.confidence] > rank[prev.confidence];
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

  if (tokenRates.length === 0) return { inputPer1M: null, outputPer1M: null, inferred: true, confidence: "low" };
  if (tokenRates.length === 1) {
    return {
      inputPer1M: tokenRates[0],
      outputPer1M: tokenRates[0],
      inferred: true,
      confidence: "low",
    };
  }

  return {
    inputPer1M: tokenRates[0],
    outputPer1M: tokenRates[tokenRates.length - 1],
    inferred: true,
    confidence: "medium",
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
