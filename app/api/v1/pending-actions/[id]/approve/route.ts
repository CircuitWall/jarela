import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { getPendingAction, setActionStatus, reservePendingApproval } from "@/lib/stores/pending-actions";
import { applyAction } from "@/lib/agents/proposals";
import { publish as publishNotification } from "@/lib/notifications/bus";
import { choiceProposalSchema, choiceResponseSchema } from "@/lib/proposals/choice";
import { pendingActionToResponse } from "@/lib/api/serializers";
import { localExecutionGuard } from "@/lib/api/local-execution-guard";

const ApproveBody = z.object({
  extras: z.record(z.string(), z.unknown()).optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const action = getPendingAction(id);
  if (!action) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (action.kind === "execute_skill" || action.kind === "execute_workflow") {
    const refused = localExecutionGuard(req);
    if (refused) return refused;
  }
  if (action.status !== "pending") {
    return NextResponse.json({ error: `already ${action.status}` }, { status: 409 });
  }
  let payload: unknown;
  try { payload = JSON.parse(action.payload); }
  catch { return NextResponse.json({ error: "Invalid stored proposal; dismiss it and create a new proposal" }, { status: 400 }); }

  // User-entered choice answers or approval-time secrets (ADR-0010).
  // Only choice answers are returned to the agent.
  let extras: Record<string, unknown> | undefined;
  const body = await req.text();
  if (body.trim()) {
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return NextResponse.json({ error: "Invalid JSON approval body" }, { status: 400 });
    }
    const parsed = ApproveBody.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    extras = parsed.data.extras;
  }

  if (action.kind === "ask_choice") {
    const question = choiceProposalSchema.safeParse(payload);
    if (!question.success) return NextResponse.json({ error: "Invalid choice proposal" }, { status: 400 });
    const answer = choiceResponseSchema(question.data).safeParse(extras);
    if (!answer.success) return NextResponse.json({ error: answer.error.message }, { status: 400 });
    extras = answer.data;
  }

  const reserved = reservePendingApproval(id);
  if (!reserved) return NextResponse.json({ error: "approval already accepted or handled; do not repeat the action" }, { status: 409 });
  let result: Awaited<ReturnType<typeof applyAction>>;
  try { result = await applyAction(reserved.kind, payload, extras); }
  catch {
    const final = setActionStatus(id, "failed", { error: "Approval application interrupted; verify external effects before retrying.", outcome: "unknown" });
    return NextResponse.json({ ok: false, action: final ? pendingActionToResponse(final) : null, error: "Approval outcome may be unknown" }, { status: 500 });
  }
  const final = setActionStatus(id, result.ok ? "approved" : "failed", result.detail);

  // The user's banner already disappears the moment the response lands;
  // the notification is just for any subscribed clients (other browser
  // tabs, mobile PWA). Fire it after the response so the approving tab
  // returns immediately.
  after(() => {
    publishNotification({
      type: "run_completed",
      thread_id: "",
      agent_id: action.agent_id,
      status: result.ok ? "done" : "error",
      preview: result.ok
        ? action.kind === "ask_choice" ? "Response recorded" : `✅ Approved & applied: ${action.kind}`
        : `⚠️ Approval failed to apply: ${typeof result.detail === "string" ? result.detail : JSON.stringify(result.detail)}`,
      ts: Date.now(),
    });
  });

  return NextResponse.json(final ? pendingActionToResponse(final) : null);
}
