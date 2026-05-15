import { NextRequest, NextResponse } from "next/server";
import { listPendingActions, type ActionStatus } from "@/lib/stores/pending-actions";

function toResponse(r: ReturnType<typeof listPendingActions>[number]) {
  return {
    id: r.id,
    agent_id: r.agent_id,
    kind: r.kind,
    payload: JSON.parse(r.payload),
    reason: r.reason,
    status: r.status,
    result: r.result ? safeParse(r.result) : null,
    created_at: r.created_at,
    decided_at: r.decided_at,
  };
}

export function GET(req: NextRequest) {
  const url = new URL(req.url);
  const status = (url.searchParams.get("status") as ActionStatus | null) ?? undefined;
  const agent_id = url.searchParams.get("agent_id") ?? undefined;
  return NextResponse.json(listPendingActions({ status, agent_id }).map(toResponse));
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
