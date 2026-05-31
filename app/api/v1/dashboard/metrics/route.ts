import { NextRequest } from "next/server";
import { cachedJson, errorResponse } from "@/lib/api/responses";
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
  try {
    await refreshPricingSnapshot({ force: false, providers: defaultPricingProviders() });
    const daysRaw = req.nextUrl.searchParams.get("days");
    const days = daysRaw ? Number(daysRaw) : undefined;
    const metrics = await getDashboardMetrics(days);
    return cachedJson(metrics, 30);
  } catch (err) {
    console.error("[dashboard-metrics] failed:", err);
    return errorResponse("Failed to load dashboard metrics", 500);
  }
}
