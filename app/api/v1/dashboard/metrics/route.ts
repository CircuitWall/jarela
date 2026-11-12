import { NextRequest } from "next/server";
import { performance } from "node:perf_hooks";
import { cachedJson, errorResponse } from "@/lib/api/responses";
import { withServerTiming } from "@/lib/api/server-timing";
import { getDashboardMetrics } from "@/lib/stores/dashboard-metrics";
import { refreshPricingSnapshot } from "@/lib/pricing/snapshot";
import { getDefaultModelConfig, getModelConfig } from "@/lib/stores/model-config";
import { getDefaultAgentConfig } from "@/lib/stores/agent-configs";

function defaultPricingProviders(): string[] {
  const providers = new Set<string>();

  const defaultModel = getDefaultModelConfig();
  if (defaultModel?.provider?.trim()) {
    providers.add(defaultModel.provider.trim().toLowerCase());
  }

  const defaultAgent = getDefaultAgentConfig();
  if (defaultAgent?.model_config_name?.trim()) {
    const cfg = getModelConfig(defaultAgent.model_config_name.trim());
    if (cfg?.provider?.trim()) {
      providers.add(cfg.provider.trim().toLowerCase());
    }
  }

  return [...providers];
}

export async function GET(req: NextRequest) {
  const requestStarted = performance.now();
  const timings: Array<{ name: string; durationMs: number; description?: string }> = [];
  try {
    const pricingStarted = performance.now();
    await refreshPricingSnapshot({ force: false, providers: defaultPricingProviders() });
    timings.push({ name: "pricing", durationMs: performance.now() - pricingStarted });
    const daysRaw = req.nextUrl.searchParams.get("days");
    const days = daysRaw ? Number(daysRaw) : undefined;
    const metricsTiming: Parameters<typeof getDashboardMetrics>[1] = {};
    const metrics = await getDashboardMetrics(days, metricsTiming);
    if (metricsTiming.queryMs !== undefined) {
      timings.push({ name: "sql", durationMs: metricsTiming.queryMs, description: "usage query" });
    }
    if (metricsTiming.aggregateMs !== undefined) {
      timings.push({ name: "aggregate", durationMs: metricsTiming.aggregateMs });
    }
    if (metricsTiming.toolStatsMs !== undefined) {
      timings.push({ name: "tool_stats", durationMs: metricsTiming.toolStatsMs, description: "tool stats query and mapping" });
    }
    if (metricsTiming.cacheHit) {
      timings.push({ name: "metrics_cache", durationMs: 0.1, description: "hit" });
    } else {
      timings.push({ name: "metrics_cache", durationMs: 0.1, description: "miss" });
    }
    const responseStarted = performance.now();
    const response = cachedJson(metrics, 30);
    timings.push({ name: "json", durationMs: performance.now() - responseStarted });
    timings.push({ name: "total", durationMs: performance.now() - requestStarted });
    return withServerTiming(response, timings);
  } catch (err) {
    console.error("[dashboard-metrics] failed:", err);
    return errorResponse("Failed to load dashboard metrics", 500);
  }
}
