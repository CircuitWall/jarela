// Server restart endpoint.
//
// POST /api/v1/system/restart
//
// Calls process.exit(0) after the response flushes, trusting the
// supervisor to relaunch us. Works under:
//   - launchd (KeepAlive=true)
//   - systemd (Restart=always|on-success)
//   - Windows Services (FailureAction=Restart)
//   - Task Scheduler (re-launch on exit 0)
//   - the `installed-launcher.ps1` / `node-pm2`-style supervisors
//
// When run with `npm start` from a terminal (no supervisor), the process
// just exits — that's correct: the user is sitting in front of a foreground
// shell and explicit restart-by-hand is the expected UX.
//
// Triggered by the Env panel "Restart" button after applying overrides
// that flagged requiresRestart=true, and by the `restart_server` agent
// tool (gated separately).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { beginThreadOperation } from "@/lib/lifecycle/system-signals";
import { getSystemOperation } from "@/lib/stores/system-signals";

const RestartBody = z.object({
  /** Optional reason logged before exit so postmortems can correlate. */
  reason: z.string().optional(),
  thread_id: z.string().min(1).max(200).optional(),
  operation_id: z.string().uuid().optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  // Body is optional; ignore parse failures and treat as empty.
  let parsed: z.infer<typeof RestartBody> = {};
  try {
    const raw: unknown = await req.json();
    const ok = RestartBody.safeParse(raw);
    if (ok.success) parsed = ok.data;
    else if (raw && typeof raw === "object" && "thread_id" in raw) {
      return NextResponse.json({ error: "Invalid agent restart context" }, { status: 400 });
    }
  } catch {
    /* body is optional */
  }
  const reason = (parsed.reason ?? "").toString().slice(0, 500);
  if (parsed.thread_id && parsed.operation_id) {
    const existing = getSystemOperation(parsed.operation_id);
    if (existing) {
      if (existing.thread_id !== parsed.thread_id || existing.kind !== "restart") {
        return NextResponse.json({ error: "Restart operation context mismatch" }, { status: 409 });
      }
      return NextResponse.json({ accepted: true, operation_id: existing.id, already_accepted: true,
        hint: "This restart operation was already accepted. Do not repeat it; inspect its completion signal on your next turn." }, { status: 202 });
    }
  }
  const operationId = parsed.thread_id
    ? beginThreadOperation(parsed.thread_id, "restart", parsed.operation_id ?? randomUUID())
    : null;
  if (parsed.thread_id && !operationId) {
    return NextResponse.json({ error: "Restart thread not found" }, { status: 404 });
  }

  // Schedule the exit AFTER returning the response so the client gets a
  // 202 confirmation. 250ms is generous enough for the response body to
  // flush through Next/Node before the process tears down — short enough
  // that the user perceives it as instant.
  setTimeout(() => {
    console.warn(`[system/restart] exiting (reason: ${reason || "<not given>"})`);
    process.exit(0);
  }, 250).unref?.();

  return NextResponse.json(
    {
      accepted: true,
      reason: reason || null,
      operation_id: operationId,
      hint: "Server will exit in ~250ms; a configured supervisor can relaunch it. Otherwise restart manually. Active runs are interrupted, not automatically resumed. For agent-initiated restarts, a completion signal is delivered on the next turn after the new instance initializes and protected state is unlocked. Do not send another restart request.",
    },
    { status: 202 },
  );
}
