import { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import { refreshPricingSnapshot } from "@/lib/pricing/snapshot";

export async function POST(req: NextRequest) {
  try {
    const force = req.nextUrl.searchParams.get("force") === "1";
    const ttlRaw = req.nextUrl.searchParams.get("ttlDays");
    const ttlDays = ttlRaw ? Number(ttlRaw) : undefined;
    const result = await refreshPricingSnapshot({ force, ttlDays });
    return Response.json({
      refreshed: result.refreshed,
      reason: result.reason,
      generated_at: result.snapshot.generated_at,
      ttl_days: result.snapshot.ttl_days,
      source_count: result.snapshot.sources.length,
    });
  } catch (err) {
    console.error("[dashboard-pricing] refresh failed:", err);
    return errorResponse("Failed to refresh pricing snapshot", 500);
  }
}
