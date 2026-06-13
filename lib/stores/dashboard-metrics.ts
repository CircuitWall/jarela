import { getDb } from "@/lib/db";
import { listToolStats, toStats } from "@/lib/stores/tool-stats";
import type { PersistedToolEvent } from "@/lib/stores/threads";
import {
  getPricingTables,
  modelRatesFor,
  estimateCostUsd,
} from "./pricing";

const CHARS_PER_TOKEN = 4;
const DEFAULT_WINDOW_DAYS = 30;

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
              mu.agent_name       AS mu_agent_name,
              mu.hot_tokens       AS mu_hot_tokens,
              mu.warm_tokens      AS mu_warm_tokens,
              mu.facts_tokens     AS mu_facts_tokens,
              mu.overhead_tokens  AS mu_overhead_tokens
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

  const tables = getPricingTables();
  const { byProvider, byProviderModel, generatedAt } = tables;
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
  const tierTotals: TierBucket = { hot: 0, warm: 0, facts: 0, overhead: 0 };
  // Data-quality counters: only assistant turns are eligible since
  // user/system rows never carry a message_usage snapshot by design.
  let measuredAssistantMessages = 0;
  let estimatedAssistantMessages = 0;

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
      if (row.role === "assistant") measuredAssistantMessages += 1;
      // Accumulate tier breakdown — null columns (legacy snapshots
      // before the tier wire-up) contribute zero, which is the right
      // behaviour for a stacked bar that visualises *known* tier split.
      const hot = row.mu_hot_tokens ?? 0;
      const warm = row.mu_warm_tokens ?? 0;
      const facts = row.mu_facts_tokens ?? 0;
      const overhead = row.mu_overhead_tokens ?? 0;
      tierTotals.hot += hot;
      tierTotals.warm += warm;
      tierTotals.facts += facts;
      tierTotals.overhead += overhead;
      dayBucket.tier.hot += hot;
      dayBucket.tier.warm += warm;
      dayBucket.tier.facts += facts;
      dayBucket.tier.overhead += overhead;
    } else if (row.role === "user" && threadHasSnapshot) {
      // Suppressed: snapshotted assistant turns in this thread already
      // capture this user message's tokens in their input_tokens.
      // Still contributes message_count via the rest of the loop.
    } else {
      const tokenEstimate = estimateTokens(row.content);
      const isInput = row.role === "user";
      inputTokens = isInput ? tokenEstimate : 0;
      outputTokens = isInput ? 0 : tokenEstimate;
      const rates = modelRatesFor(tables, row.provider, row.model_id);
      estCost = estimateCostUsd(inputTokens, outputTokens, rates);
      if (row.role === "assistant") estimatedAssistantMessages += 1;
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
      tier_tokens: tierBucketToTokens(b.tier),
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
        tier_tokens: dayPoint?.tier_tokens ?? emptyTierTokens(),
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
      tier_tokens: tierBucketToTokens(tierTotals),
      data_quality: computeDataQuality(measuredAssistantMessages, estimatedAssistantMessages),
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
      tier: { hot: 0, warm: 0, facts: 0, overhead: 0 },
    });
  }
  return out;
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
