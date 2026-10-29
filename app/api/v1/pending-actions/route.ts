import { NextRequest, NextResponse } from "next/server";
import { listPendingActions, type ActionStatus } from "@/lib/stores/pending-actions";
import { pendingActionToResponse } from "@/lib/api/serializers";

export function GET(req: NextRequest) {
  const url = new URL(req.url);
  const status = (url.searchParams.get("status") as ActionStatus | null) ?? undefined;
  const agent_id = url.searchParams.get("agent_id") ?? undefined;
  return NextResponse.json(listPendingActions({ status, agent_id }).map(pendingActionToResponse));
}
