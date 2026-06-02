// Read-only telemetry endpoint for the output validator (ADR-0037 / -0057).
//
// Surfaces the in-memory ring buffer's stats so the operator can answer
// "is the output validator earning its 555 LOC?" without scraping logs.
// Structure:
//   GET /api/v1/dashboard/validator
//     → { total, ok, by_kind, by_stage, hit_rate, disabled }
//   GET /api/v1/dashboard/validator?recent=20
//     → adds an `entries` array with the most recent 20 fires
//
// Process-local: stats reset on server restart by design. The decision
// criterion is "rate over the last few runs" — historical data isn't
// needed for the kill/keep call.

import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/responses";
import {
  getValidatorStats,
  recentValidatorEntries,
} from "@/lib/agents/output-validator/telemetry";

export async function GET(req: NextRequest) {
  try {
    const stats = getValidatorStats();
    const url = new URL(req.url);
    const recentParam = url.searchParams.get("recent");
    const recent = recentParam ? Math.max(0, Math.min(500, Number(recentParam) | 0)) : 0;
    const body: Record<string, unknown> = { ...stats };
    if (recent > 0) {
      body.entries = recentValidatorEntries(recent);
    }
    return NextResponse.json(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(`validator stats failed: ${msg}`, 500, "internal_error");
  }
}
