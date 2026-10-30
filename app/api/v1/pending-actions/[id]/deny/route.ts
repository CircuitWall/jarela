import { NextRequest, NextResponse } from "next/server";
import { getPendingAction, setActionStatus } from "@/lib/stores/pending-actions";
import { getSystemOperation } from "@/lib/stores/system-signals";
import { pendingActionToResponse } from "@/lib/api/serializers";
import { localExecutionGuard } from "@/lib/api/local-execution-guard";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const action = getPendingAction(id);
  if (!action) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (action.kind === "execute_skill" || action.kind === "execute_workflow") {
    const refused = localExecutionGuard(_req);
    if (refused) return refused;
  }
  if (action.status !== "pending") {
    return NextResponse.json({ error: `already ${action.status}` }, { status: 409 });
  }
  if (getSystemOperation(`approval:${id}`)?.state === "accepted") {
    return NextResponse.json({ error: "approval application is already in progress; verify its outcome" }, { status: 409 });
  }
  const final = setActionStatus(id, "denied", "user denied");
  if (action.kind === "execute_skill") {
    const payload: unknown = JSON.parse(action.payload);
    if (payload && typeof payload === "object" && "request_id" in payload && typeof payload.request_id === "string") {
      const { skillExecutionService } = await import("@/lib/skills/execution-service");
      try { skillExecutionService().cancel(payload.request_id); }
      catch (error) { console.warn("[skill-execution] denied request no longer live:", error instanceof Error ? error.message : "unknown failure"); }
    }
  }
  if (action.kind === "execute_workflow") {
    const payload: unknown = JSON.parse(action.payload);
    if (payload && typeof payload === "object" && "workflow_run_id" in payload && typeof payload.workflow_run_id === "string") {
      const { revokeWorkflowAuthorizations } = await import("@/lib/workflows/authorization");
      revokeWorkflowAuthorizations(payload.workflow_run_id);
    }
  }
  return NextResponse.json(final ? pendingActionToResponse(final) : null);
}
