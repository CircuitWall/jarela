import { getDb } from "@/lib/db";
import type { DashboardCostBreakdown } from "@/api/types";
import { listToolStats, toStats } from "@/lib/stores/tool-stats";
import type { PersistedToolEvent } from "@/lib/stores/threads";
import {
  getPricingTables,
  modelRatesFor,
  estimateCostUsd,
  dashboardModelRates,
  estimateProviderCostUsd,
  type PricingTables,
} from "./pricing";

const CHARS_PER_TOKEN = 4;
const DEFAULT_WINDOW_DAYS = 30;
const METRICS_CACHE_MS = 5_000;

let metricsCache: {
  db: ReturnType<typeof getDb>;
  changes: number;
  dataVersion: number;
  tables: PricingTables;
  createdAt: number;
  metrics: DashboardMetrics;
} | null = null;

export interface DashboardTierTokens {
  hot_tokens: number;
  warm_tokens: number;
  facts_tokens: number;
  overhead_tokens: number;
  /** Sum of the four tiers — convenience for stacked-bar totals. */
  measured_input_tokens: number;
}

export interface DashboardDataQuality {
  /** Assistant turns in the window that have an immutable message_usage snapshot. */
  measured_messages: number;
  /** Assistant turns falling back to content-length estimates. */
  estimated_messages: number;
  /** measured / (measured + estimated), 0..1; 1 when no traffic. */
  measured_pct: number;
}

export interface DashboardSeriesPoint {
  day: string;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
  cost_breakdown: DashboardCostBreakdown;
  tool_calls: number;
  tool_successes: number;
  tool_errors: number;
  success_rate: number;
  error_rate: number;
  /** Per-tier breakdown of authoritative snapshot input tokens for the
   *  day. Zero for legacy rows with no message_usage entry — these are
   *  surfaced via the `data_quality` chip instead so users know the bar
   *  reflects only measured traffic. */
  tier_tokens: DashboardTierTokens;
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
  cost_breakdown: DashboardCostBreakdown;
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
  cost_breakdown: DashboardCostBreakdown;
}

export interface DashboardModelBreakdown {
  model_config_name: string;
  provider: string;
  model_id: string;
  message_count: number;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
  cost_breakdown: DashboardCostBreakdown;
}

export interface DashboardDayBreakdown {
  day: string;
  summary: {
    input_tokens_est: number;
    output_tokens_est: number;
    estimated_cost_usd: number;
    cost_breakdown: DashboardCostBreakdown;
    tool_calls: number;
    tool_successes: number;
    tool_errors: number;
    success_rate: number;
    error_rate: number;
    tier_tokens: DashboardTierTokens;
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
    cost_breakdown: DashboardCostBreakdown;
    recorded_cost_usd: number;
    cache_read_tokens: number;
    cache_hit_rate: number;
    tool_calls: number;
    tool_successes: number;
    tool_errors: number;
    success_rate: number;
    error_rate: number;
    tier_tokens: DashboardTierTokens;
    data_quality: DashboardDataQuality;
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
    aggregator_sources: PricingTables["aggregatorSources"];
    aggregator_model_rates: PricingTables["aggregatorModelRates"];
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
  mu_hot_tokens: number | null;
  mu_warm_tokens: number | null;
  mu_facts_tokens: number | null;
  mu_overhead_tokens: number | null;
  mu_cache_read: number | null;
  mu_cache_creation: number | null;
};

type TierBucket = {
  hot: number;
  warm: number;
  facts: number;
  overhead: number;
};

type DayBucket = {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  cost_breakdown: DashboardCostBreakdown;
  toolCalls: number;
  toolSuccesses: number;
  toolErrors: number;
  tier: TierBucket;
};

type AgentBucket = {
  agent_id: string;
  agent_name: string;
  message_count: number;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
  cost_breakdown: DashboardCostBreakdown;
};

type ProviderBucket = {
  provider: string;
  message_count: number;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
  cost_breakdown: DashboardCostBreakdown;
};

type ModelBucket = {
  model_config_name: string;
  provider: string;
  model_id: string;
  message_count: number;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
  cost_breakdown: DashboardCostBreakdown;
};

type SnapshotCostInput = {
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  recordedCostUsd: number;
};

export function recalculateSnapshotCostBreakdown(
  input: SnapshotCostInput, tables: PricingTables,
): DashboardCostBreakdown {
  const rates = modelRatesFor(tables, input.provider, input.modelId);
  if (rates.inputPer1M == null && rates.outputPer1M == null) {
    return { ...emptyCostBreakdown(), unattributed_cost_usd: input.recordedCostUsd };
  }
  return {
    input_cost_usd: estimateProviderCostUsd(input.provider, input.inputTokens, 0, rates, {
      cache_creation_input_tokens: input.cacheCreationTokens,
      cache_read_input_tokens: input.cacheReadTokens,
    }),
    output_cost_usd: estimateCostUsd(0, input.outputTokens, rates),
    unattributed_cost_usd: 0,
  };
}

export function recalculateSnapshotCost(input: SnapshotCostInput, tables: PricingTables): number {
  return totalCostBreakdown(recalculateSnapshotCostBreakdown(input, tables));
}

export async function getDashboardMetrics(days = DEFAULT_WINDOW_DAYS): Promise<DashboardMetrics> {
  const now = new Date();
  const boundedDays = Number.isFinite(days) ? Math.min(120, Math.max(7, Math.floor(days))) : DEFAULT_WINDOW_DAYS;
  const since = new Date(now.getTime() - (boundedDays * 24 * 60 * 60 * 1000)).toISOString();
  const db = getDb();
  const tables = getPricingTables();
  // total_changes covers this connection; data_version covers other writers.
  const { changes } = db.prepare("SELECT total_changes() AS changes").get() as { changes: number };
  const { data_version: dataVersion } = db.prepare("PRAGMA data_version").get() as { data_version: number };
  if (metricsCache?.db === db && metricsCache.changes === changes
    && metricsCache.dataVersion === dataVersion && metricsCache.tables === tables
    && metricsCache.metrics.days === boundedDays
    && metricsCache.metrics.generated_at.slice(0, 10) === now.toISOString().slice(0, 10)
    && now.getTime() - metricsCache.createdAt >= 0
    && now.getTime() - metricsCache.createdAt < METRICS_CACHE_MS) {
    return metricsCache.metrics;
  }

  const rows = readDashboardUsage(db, since);
  const dayMap = seedDayBuckets(now, boundedDays);
  const { totals, attribution, days: dayBreakdowns } = aggregateDashboardUsage(rows, tables, dayMap);
  const series = buildDashboardSeries(dayMap);
  const metrics: DashboardMetrics = {
    generated_at: now.toISOString(),
    days: boundedDays,
    summary: {
      input_tokens_est: totals.inputTokens,
      output_tokens_est: totals.outputTokens,
      estimated_cost_usd: totals.estimatedCost,
      cost_breakdown: totals.cost_breakdown,
      recorded_cost_usd: totals.recordedCost,
      cache_read_tokens: totals.cacheRead,
      cache_hit_rate: round4(totals.cacheRead > 0 ? totals.cacheRead / (totals.inputTokens + totals.cacheRead) : 0),
      tool_calls: totals.toolCalls,
      tool_successes: totals.toolSuccesses,
      tool_errors: totals.toolErrors,
      success_rate: round4(totals.toolCalls > 0 ? totals.toolSuccesses / totals.toolCalls : 1),
      error_rate: round4(totals.toolCalls > 0 ? totals.toolErrors / totals.toolCalls : 0),
      tier_tokens: tierBucketToTokens(totals.tier),
      data_quality: computeDataQuality(totals.measured, totals.estimated),
    },
    series,
    top_tools: dashboardTopTools(),
    top_agents: rankDashboardBuckets(attribution.agents, (row) => row.agent_name).slice(0, 8),
    by_provider: rankDashboardBuckets(attribution.providers, (row) => row.provider),
    by_model: rankDashboardBuckets(attribution.models, (row) => row.model_config_name),
    breakdowns_by_day: buildDayBreakdowns(dayBreakdowns, series),
    pricing: dashboardPricing(tables),
  };
  metricsCache = { db, changes, dataVersion, tables, createdAt: now.getTime(), metrics };
  return metrics;
}

function readDashboardUsage(db: ReturnType<typeof getDb>, since: string): UsageRow[] {
  const usageRows = db
    .prepare(
      `SELECT m.created_at, m.role,
              CASE WHEN mu.input_tokens IS NULL THEN m.content ELSE '' END AS content,
              m.tool_events, m.thread_id, t.agent_id,
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
              mu.agent_name       AS mu_agent_name,
              mu.hot_tokens       AS mu_hot_tokens,
              mu.warm_tokens      AS mu_warm_tokens,
              mu.facts_tokens     AS mu_facts_tokens,
              mu.overhead_tokens  AS mu_overhead_tokens,
              mu.cache_read_input_tokens    AS mu_cache_read,
              mu.cache_creation_input_tokens AS mu_cache_creation
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

  return usageRows;
}

type UsageAttribution = {
  agentId: string;
  agentName: string | null;
  provider: string | null;
  modelId: string | null;
  modelConfig: string | null;
};

function resolveDashboardUsage(row: UsageRow, threadHasSnapshot: boolean, tables: PricingTables) {
  const hasSnapshot = row.mu_input_tokens != null;
  const attribution: UsageAttribution = {
    agentId: row.mu_agent_id ?? row.agent_id,
    agentName: row.mu_agent_name ?? row.agent_name,
    provider: row.mu_provider ?? row.provider,
    modelId: row.mu_model_id ?? row.model_id,
    modelConfig: row.mu_model_config_name ?? row.model_config_name,
  };
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCost = 0;
  let costs = emptyCostBreakdown();
  const tier: TierBucket = { hot: 0, warm: 0, facts: 0, overhead: 0 };
  let estimated = 0;
  if (hasSnapshot) {
    inputTokens = row.mu_input_tokens ?? 0;
    outputTokens = row.mu_output_tokens ?? 0;
    costs = recalculateSnapshotCostBreakdown({
      provider: attribution.provider ?? "",
      modelId: attribution.modelId ?? "",
      inputTokens, outputTokens,
      cacheCreationTokens: row.mu_cache_creation,
      cacheReadTokens: row.mu_cache_read,
      recordedCostUsd: row.mu_cost_usd ?? 0,
    }, tables);
    estimatedCost = totalCostBreakdown(costs);
    tier.hot = row.mu_hot_tokens ?? 0;
    tier.warm = row.mu_warm_tokens ?? 0;
    tier.facts = row.mu_facts_tokens ?? 0;
    tier.overhead = row.mu_overhead_tokens ?? 0;
  } else {
    // Snapshot attribution is authoritative only when a snapshot exists.
    attribution.agentId = row.agent_id;
    attribution.agentName = row.agent_name;
    attribution.provider = row.provider;
    attribution.modelId = row.model_id;
    attribution.modelConfig = row.model_config_name;
    if (!(row.role === "user" && threadHasSnapshot)) {
      const tokens = estimateTokens(row.content);
      inputTokens = row.role === "user" ? tokens : 0;
      outputTokens = row.role === "user" ? 0 : tokens;
      const rates = modelRatesFor(tables, row.provider, row.model_id);
      estimatedCost = estimateCostUsd(inputTokens, outputTokens, rates);
      costs = {
        input_cost_usd: estimateCostUsd(inputTokens, 0, rates),
        output_cost_usd: estimateCostUsd(0, outputTokens, rates),
        unattributed_cost_usd: 0,
      };
      if (row.role === "assistant") estimated = 1;
    }
  }
  return {
    attribution, inputTokens, outputTokens, estimatedCost, costs, tier, estimated,
    measured: hasSnapshot && row.role === "assistant" ? 1 : 0,
    recordedCost: hasSnapshot ? row.mu_cost_usd ?? 0 : 0,
    cacheRead: hasSnapshot ? row.mu_cache_read ?? 0 : 0,
  };
}

type ResolvedDashboardUsage = ReturnType<typeof resolveDashboardUsage>;
type AttributionMaps = {
  agents: Map<string, AgentBucket>;
  providers: Map<string, ProviderBucket>;
  models: Map<string, ModelBucket>;
};

function createAttributionMaps(): AttributionMaps {
  return { agents: new Map(), providers: new Map(), models: new Map() };
}

function emptyUsageBucket() {
  return { message_count: 0, input_tokens_est: 0, output_tokens_est: 0, estimated_cost_usd: 0, cost_breakdown: emptyCostBreakdown() };
}

function addUsageBucket<T extends ReturnType<typeof emptyUsageBucket>>(
  map: Map<string, T>, key: string, seed: T, usage: ResolvedDashboardUsage,
): void {
  const bucket = map.get(key) ?? seed;
  bucket.message_count += 1;
  bucket.input_tokens_est += usage.inputTokens;
  bucket.output_tokens_est += usage.outputTokens;
  bucket.estimated_cost_usd += usage.estimatedCost;
  addCostBreakdown(bucket.cost_breakdown, usage.costs);
  map.set(key, bucket);
}

function addDashboardAttribution(maps: AttributionMaps, usage: ResolvedDashboardUsage): void {
  const { agentId, agentName, provider, modelId, modelConfig } = usage.attribution;
  const providerName = provider?.trim().toLowerCase() || "unassigned";
  const modelConfigName = modelConfig?.trim() || "unassigned";
  const resolvedModelId = modelId?.trim() || "unknown";
  addUsageBucket(maps.agents, agentId, {
    ...emptyUsageBucket(), agent_id: agentId, agent_name: agentName?.trim() || agentId,
  }, usage);
  addUsageBucket(maps.providers, providerName, {
    ...emptyUsageBucket(), provider: providerName,
  }, usage);
  addUsageBucket(maps.models, `${providerName}::${modelConfigName}::${resolvedModelId}`, {
    ...emptyUsageBucket(), model_config_name: modelConfigName, provider: providerName, model_id: resolvedModelId,
  }, usage);
}

function addDashboardDay(bucket: DayBucket, usage: ResolvedDashboardUsage, tools: ReturnType<typeof summarizeEvents>): void {
  bucket.inputTokens += usage.inputTokens;
  bucket.outputTokens += usage.outputTokens;
  bucket.estimatedCost += usage.estimatedCost;
  addCostBreakdown(bucket.cost_breakdown, usage.costs);
  bucket.tier.hot += usage.tier.hot;
  bucket.tier.warm += usage.tier.warm;
  bucket.tier.facts += usage.tier.facts;
  bucket.tier.overhead += usage.tier.overhead;
  bucket.toolCalls += tools.calls;
  bucket.toolSuccesses += tools.successes;
  bucket.toolErrors += tools.errors;
}

function aggregateDashboardUsage(rows: UsageRow[], tables: PricingTables, dayMap: Map<string, DayBucket>) {
  // Only provider-token snapshots suppress user estimates, not context-only snapshots.
  const snapshotThreadIds = new Set(rows.filter((row) => row.mu_input_tokens != null && row.mu_input_tokens > 0)
    .map((row) => row.thread_id));
  const attribution = createAttributionMaps();
  const days = new Map<string, AttributionMaps>();
  const totals = {
    inputTokens: 0, outputTokens: 0, estimatedCost: 0, cost_breakdown: emptyCostBreakdown(),
    toolCalls: 0, toolSuccesses: 0, toolErrors: 0,
    tier: { hot: 0, warm: 0, facts: 0, overhead: 0 },
    recordedCost: 0, cacheRead: 0, measured: 0, estimated: 0,
  };
  for (const row of rows) {
    const day = row.created_at.slice(0, 10);
    const bucket = dayMap.get(day);
    if (!bucket) continue;
    const usage = resolveDashboardUsage(row, snapshotThreadIds.has(row.thread_id), tables);
    const tools = row.tool_events && row.tool_events.length > 1
      ? summarizeEvents(row.tool_events) : { calls: 0, successes: 0, errors: 0 };
    addDashboardDay(bucket, usage, tools);
    addDashboardDay(totals, usage, tools);
    totals.recordedCost += usage.recordedCost;
    totals.cacheRead += usage.cacheRead;
    totals.measured += usage.measured;
    totals.estimated += usage.estimated;
    const dayAttribution = days.get(day) ?? createAttributionMaps();
    addDashboardAttribution(attribution, usage);
    addDashboardAttribution(dayAttribution, usage);
    days.set(day, dayAttribution);
  }
  return { totals, attribution, days };
}

function buildDashboardSeries(dayMap: Map<string, DayBucket>): DashboardSeriesPoint[] {
  return [...dayMap.entries()].map(([day, b]) => ({
    day, input_tokens_est: b.inputTokens, output_tokens_est: b.outputTokens,
    estimated_cost_usd: b.estimatedCost, cost_breakdown: b.cost_breakdown,
    tool_calls: b.toolCalls, tool_successes: b.toolSuccesses, tool_errors: b.toolErrors,
    success_rate: round4(b.toolCalls > 0 ? b.toolSuccesses / b.toolCalls : 1),
    error_rate: round4(b.toolCalls > 0 ? b.toolErrors / b.toolCalls : 0),
    tier_tokens: tierBucketToTokens(b.tier),
  }));
}

function rankDashboardBuckets<T extends { estimated_cost_usd: number; message_count: number }>(
  map: Map<string, T>, label: (bucket: T) => string,
): T[] {
  return [...map.values()].sort((a, b) =>
    b.estimated_cost_usd - a.estimated_cost_usd || b.message_count - a.message_count || label(a).localeCompare(label(b)));
}

function buildDayBreakdowns(days: Map<string, AttributionMaps>, series: DashboardSeriesPoint[]): Record<string, DashboardDayBreakdown> {
  const seriesByDay = new Map(series.map((point) => [point.day, point]));
  return Object.fromEntries([...days].map(([day, bucket]) => {
    const point = seriesByDay.get(day);
    return [day, {
      day,
      summary: {
        input_tokens_est: point?.input_tokens_est ?? 0,
        output_tokens_est: point?.output_tokens_est ?? 0,
        estimated_cost_usd: point?.estimated_cost_usd ?? 0,
        cost_breakdown: point?.cost_breakdown ?? emptyCostBreakdown(),
        tool_calls: point?.tool_calls ?? 0, tool_successes: point?.tool_successes ?? 0,
        tool_errors: point?.tool_errors ?? 0, success_rate: point?.success_rate ?? 1,
        error_rate: point?.error_rate ?? 0, tier_tokens: point?.tier_tokens ?? emptyTierTokens(),
      },
      top_agents: rankDashboardBuckets(bucket.agents, (row) => row.agent_name).slice(0, 8),
      by_provider: rankDashboardBuckets(bucket.providers, (row) => row.provider),
      by_model: rankDashboardBuckets(bucket.models, (row) => row.model_config_name),
    }];
  }));
}

function dashboardTopTools(): DashboardToolTop[] {
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

  return top_tools;
}

function dashboardPricing(tables: PricingTables): DashboardMetrics["pricing"] {
  const { byProvider, generatedAt } = tables;
  return {
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
      model_rates: dashboardModelRates(tables).map((rates) => ({
        provider: rates.provider,
        model_id: rates.model_id,
        input_per_1m_usd: rates.inputPer1M,
        output_per_1m_usd: rates.outputPer1M,
        source: rates.source,
        inferred: rates.inferred,
        confidence: rates.confidence,
        ok: rates.ok,
        status: rates.status,
        error: rates.error,
      } satisfies DashboardModelRate)),
      aggregator_sources: tables.aggregatorSources,
      aggregator_model_rates: tables.aggregatorModelRates,
      notes: "Dashboard cost is recalculated from captured provider token usage and the latest matching rates. The original per-turn cost snapshots remain unchanged; legacy rows use content-length token estimates.",
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
      cost_breakdown: emptyCostBreakdown(),
      toolCalls: 0,
      toolSuccesses: 0,
      toolErrors: 0,
      tier: { hot: 0, warm: 0, facts: 0, overhead: 0 },
    });
  }
  return out;
}

function emptyCostBreakdown(): DashboardCostBreakdown {
  return { input_cost_usd: 0, output_cost_usd: 0, unattributed_cost_usd: 0 };
}

function totalCostBreakdown(costs: DashboardCostBreakdown): number {
  return costs.input_cost_usd + costs.output_cost_usd + costs.unattributed_cost_usd;
}

function addCostBreakdown(target: DashboardCostBreakdown, costs: DashboardCostBreakdown): void {
  target.input_cost_usd += costs.input_cost_usd;
  target.output_cost_usd += costs.output_cost_usd;
  target.unattributed_cost_usd += costs.unattributed_cost_usd;
}

function emptyTierTokens(): DashboardTierTokens {
  return { hot_tokens: 0, warm_tokens: 0, facts_tokens: 0, overhead_tokens: 0, measured_input_tokens: 0 };
}

function tierBucketToTokens(b: TierBucket): DashboardTierTokens {
  return {
    hot_tokens: b.hot,
    warm_tokens: b.warm,
    facts_tokens: b.facts,
    overhead_tokens: b.overhead,
    measured_input_tokens: b.hot + b.warm + b.facts + b.overhead,
  };
}

export function computeDataQuality(measured: number, estimated: number): DashboardDataQuality {
  const total = measured + estimated;
  return {
    measured_messages: measured,
    estimated_messages: estimated,
    measured_pct: total === 0 ? 1 : round4(measured / total),
  };
}

function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / CHARS_PER_TOKEN));
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

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
