// GET /api/v1/health/probes        → returns the last known probe snapshot.
// GET /api/v1/health/probes?refresh=1 → runs every probe synchronously
//                                       then returns the fresh snapshot.
//
// Sibling of /api/v1/health (which is a liveness check). The probe data
// drives a future "Status" panel and the early-error toasts described in
// lib/health/runner.ts.
import { NextRequest, NextResponse } from "next/server";
import { getHealthSnapshot, runAllHealthProbes } from "@/lib/health/runner";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const refresh = url.searchParams.get("refresh") === "1";
  if (refresh) {
    const snapshot = await runAllHealthProbes();
    return NextResponse.json(snapshot);
  }
  return NextResponse.json(getHealthSnapshot());
}
