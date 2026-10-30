import { NextRequest, NextResponse } from "next/server";
import { getPendingAction, setActionStatus } from "@/lib/stores/pending-actions";
import { getSystemOperation } from "@/lib/stores/system-signals";
import { pendingActionToResponse } from "@/lib/api/serializers";
import { localExecutionGuard } from "@/lib/api/local-execution-guard";
import { errorResponse } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const action = getPendingAction(id);
  if (!action) return errorResponse(NOT_FOUND_ERRORS.LEGACY, 404);
  if (action.kind === "execute_skill" || action.kind === "execute_workflow" || action.kind === "authoring_operation") {
    const refused = localExecutionGuard(_req);
    if (refused) return refused;
  }
  if (action.status !== "pending") {
    return errorResponse(`already ${action.status}`, 409);
  }
  if (getSystemOperation(`approval:${id}`)?.state === "accepted") {
    return errorResponse("approval application is already in progress; verify its outcome", 409);
  }
  const final = setActionStatus(id, "denied", "user denied");
  if (action.kind === "authoring_operation") {
    const { AuthoringApprovalPayload, cancelAuthoringOperation, inspectAuthoringOperation } = await import("@/lib/workflows/authoring-operations");
    try {
      const payload = AuthoringApprovalPayload.parse(JSON.parse(action.payload));
      const live = await inspectAuthoringOperation(payload.operation_id, payload.operation_type, action.agent_id);
      if (live.proposal_id !== id) throw new Error("Denied proposal no longer owns the current stage");
      await cancelAuthoringOperation(payload.operation_id, payload.operation_type, action.agent_id);
    } catch (error) { console.warn("[authoring] denied operation no longer live", error instanceof Error ? error.message : "unknown failure"); }
  }
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
