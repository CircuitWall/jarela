import { NextRequest, NextResponse } from "next/server";
import { getPendingAction, setActionStatus } from "@/lib/stores/pending-actions";
import { applyAction } from "@/lib/agents/proposals";
import { publish as publishNotification } from "@/lib/notifications/bus";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const action = getPendingAction(id);
  if (!action) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (action.status !== "pending") {
    return NextResponse.json({ error: `already ${action.status}` }, { status: 409 });
  }

  const result = await applyAction(action.kind, JSON.parse(action.payload));
  const final = setActionStatus(id, result.ok ? "approved" : "failed", result.detail);

  publishNotification({
    type: "run_completed",
    thread_id: "",
    agent_id: action.agent_id,
    status: result.ok ? "done" : "error",
    preview: result.ok
      ? `✅ Approved & applied: ${action.kind}`
      : `⚠️ Approval failed to apply: ${typeof result.detail === "string" ? result.detail : JSON.stringify(result.detail)}`,
    ts: Date.now(),
  });

  return NextResponse.json(final);
}
