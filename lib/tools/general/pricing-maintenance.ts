import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getDashboardMetrics } from "@/lib/stores/dashboard-metrics";
import { readPricingSnapshot, refreshPricingSnapshot, type PricingSnapshot } from "@/lib/pricing/snapshot";
import { registerLangChainPackage } from "../packages/langchain-package";

type ModelRate = NonNullable<PricingSnapshot["sources"][number]["model_rates"]>[number];

function rateKey(sourceId: string, modelId: string): string {
  return `${sourceId}::${modelId.trim().toLowerCase()}`;
}

function changedRates(
  previous: Awaited<ReturnType<typeof readPricingSnapshot>>,
  current: NonNullable<Awaited<ReturnType<typeof readPricingSnapshot>>>,
): Array<{
  provider: string;
  model_id: string;
  previous_input_per_1m_usd: number | null;
  previous_output_per_1m_usd: number | null;
  input_per_1m_usd: number | null;
  output_per_1m_usd: number | null;
  confidence: ModelRate["confidence"];
}> {
  const previousRates = new Map<string, { input: number | null; output: number | null }>();
  for (const source of previous?.sources ?? []) {
    for (const rate of source.model_rates ?? []) {
      previousRates.set(rateKey(source.id, rate.model_id), {
        input: rate.input_per_1m_usd,
        output: rate.output_per_1m_usd,
      });
    }
  }

  const changes: ReturnType<typeof changedRates> = [];
  for (const source of current.sources) {
    for (const rate of source.model_rates ?? []) {
      const old = previousRates.get(rateKey(source.id, rate.model_id));
      if (old && old.input === rate.input_per_1m_usd && old.output === rate.output_per_1m_usd) continue;
      changes.push({
        provider: source.id,
        model_id: rate.model_id,
        previous_input_per_1m_usd: old?.input ?? null,
        previous_output_per_1m_usd: old?.output ?? null,
        input_per_1m_usd: rate.input_per_1m_usd,
        output_per_1m_usd: rate.output_per_1m_usd,
        confidence: rate.confidence,
      });
    }
  }
  return changes.slice(0, 100);
}

function removedRates(
  previous: Awaited<ReturnType<typeof readPricingSnapshot>>,
  current: NonNullable<Awaited<ReturnType<typeof readPricingSnapshot>>>,
): Array<{ provider: string; model_id: string; input_per_1m_usd: number | null; output_per_1m_usd: number | null }> {
  const currentIds = new Map(current.sources.map((source) => [source.id, source]));
  const removed: Array<{ provider: string; model_id: string; input_per_1m_usd: number | null; output_per_1m_usd: number | null }> = [];
  for (const source of previous?.sources ?? []) {
    const refreshed = currentIds.get(source.id);
    if (!refreshed?.ok) continue;
    const currentModels = new Set((refreshed.model_rates ?? []).map((rate) => rateKey(refreshed.id, rate.model_id)));
    for (const rate of source.model_rates ?? []) {
      if (currentModels.has(rateKey(source.id, rate.model_id))) continue;
      removed.push({
        provider: source.id,
        model_id: rate.model_id,
        input_per_1m_usd: rate.input_per_1m_usd,
        output_per_1m_usd: rate.output_per_1m_usd,
      });
    }
  }
  return removed.slice(0, 100);
}

export async function refreshModelPricing(): Promise<Record<string, unknown>> {
  const previous = await readPricingSnapshot();
  const { snapshot, refreshed, reason } = await refreshPricingSnapshot({ force: true });
  const dashboard = await getDashboardMetrics();
  return {
    refreshed,
    reason,
    generated_at: snapshot.generated_at,
    changed_rates: changedRates(previous, snapshot),
    removed_rates: removedRates(previous, snapshot),
    sources: snapshot.sources.map((source) => ({
      id: source.id,
      ok: source.ok,
      fetched_at: source.fetched_at,
      model_rate_count: source.model_rates?.length ?? 0,
      error: source.error,
    })),
    dashboard: {
      days: dashboard.days,
      current_rate_estimated_cost_usd: dashboard.summary.estimated_cost_usd,
      recorded_snapshot_cost_usd: dashboard.summary.recorded_cost_usd,
      snapshot_generated_at: dashboard.pricing.snapshot_generated_at,
    },
  };
}

const refreshModelPricingTool = tool(
  async () => JSON.stringify(await refreshModelPricing()),
  {
    name: "refresh_model_pricing",
    description: "Refresh the configured official LLM pricing sources and recalculate dashboard estimates using the latest rates. Returns rate changes, source health, confidence, and current-versus-recorded dashboard totals. These are estimates, not invoice amounts.",
    schema: z.object({}),
  },
);

registerLangChainPackage({ category: "Config", tools: { write: [refreshModelPricingTool] } });