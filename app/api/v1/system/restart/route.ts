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

interface RestartBody {
  /** Optional reason logged before exit so postmortems can correlate. */
  reason?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: RestartBody = {};
  try {
    body = (await req.json()) as RestartBody;
  } catch {
    /* body is optional */
  }
  const reason = (body.reason ?? "").toString().slice(0, 500);

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
      hint: "Server will exit in ~250ms; supervisor (launchd/systemd/Task Scheduler) will relaunch. If running via `npm start` directly, restart manually.",
    },
    { status: 202 },
  );
}
