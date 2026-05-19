import { NextRequest, NextResponse, after } from "next/server";
import { getPendingAction, setActionStatus } from "@/lib/stores/pending-actions";
import { applyAction } from "@/lib/agents/proposals";
import { publish as publishNotification } from "@/lib/notifications/bus";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const action = getPendingAction(id);
  if (!action) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (action.status !== "pending") {
    return NextResponse.json({ error: `already ${action.status}` }, { status: 409 });
  }

  // Optional approval-time secret material (ADR-0010). The agent never sees
  // these — they come from the secret-input modal in the approval banner.
  let extras: Record<string, unknown> | undefined;
  if (req.headers.get("content-length") && req.headers.get("content-length") !== "0") {
    try {
      const body = (await req.json()) as { extras?: Record<string, unknown> } | null;
      if (body && body.extras && typeof body.extras === "object") extras = body.extras;
    } catch {
      // Empty / non-JSON body is fine — fall back to extras=undefined.
    }
  }

  const result = await applyAction(action.kind, JSON.parse(action.payload), extras);
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
        ? `✅ Approved & applied: ${action.kind}`
        : `⚠️ Approval failed to apply: ${typeof result.detail === "string" ? result.detail : JSON.stringify(result.detail)}`,
      ts: Date.now(),
    });
  });

  return NextResponse.json(final);
}
