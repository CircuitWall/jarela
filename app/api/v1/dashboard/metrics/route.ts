import { NextRequest } from "next/server";
import { cachedJson, errorResponse } from "@/lib/api/responses";
import { getDashboardMetrics } from "@/lib/stores/dashboard-metrics";
import { refreshPricingSnapshot } from "@/lib/pricing/snapshot";

export async function GET(req: NextRequest) {
  try {
    await refreshPricingSnapshot({ force: false });
    const daysRaw = req.nextUrl.searchParams.get("days");
    const days = daysRaw ? Number(daysRaw) : undefined;
    const metrics = await getDashboardMetrics(days);
    return cachedJson(metrics, 30);
  } catch (err) {
    console.error("[dashboard-metrics] failed:", err);
    return errorResponse("Failed to load dashboard metrics", 500);
  }
}
