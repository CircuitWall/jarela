// Soft-reset endpoint.
//
// POST /api/v1/system/abort
//
// Aborts every currently-running LangGraph run (agent turn) without
// tearing down the process. Use this when in-flight work is stuck and
// you want to unblock the UI without restarting the server (which would
// reset bridges, the scheduler tick, and — under the encrypted-master-
// key config — cost a PIN re-entry).
//
// For a full process restart use POST /api/v1/system/restart instead.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { abortAllRuns } from "@/lib/agents/run-registry";

const AbortBody = z.object({
  /** Optional reason logged with the abort. */
  reason: z.string().max(500).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  let parsed: { reason?: string } = {};
  try {
    const raw: unknown = await req.json();
    const ok = AbortBody.safeParse(raw);
    if (ok.success) parsed = ok.data;
  } catch {
    /* body is optional */
  }
  const reason = (parsed.reason ?? "user_reset").toString().slice(0, 500);
  const aborted = abortAllRuns(reason);
  console.warn(`[system/abort] aborted ${aborted} in-flight run(s) (reason: ${reason})`);
  return NextResponse.json({ aborted, reason });
}
