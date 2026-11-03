/**
 * @public — `GET /api/v1/health/liveness`
 *
 * Fast process liveness without database or agent-configuration reads.
 */

import { NextResponse } from "next/server";
import { getActiveRunCount } from "@/lib/agents/run-registry";

export function GET() {
  return NextResponse.json({
    status: "ok",
    activity: { active_runs: getActiveRunCount() },
  }, { headers: { "Cache-Control": "no-store" } });
}
