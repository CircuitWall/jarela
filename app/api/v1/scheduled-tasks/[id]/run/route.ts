import { NextRequest, NextResponse, after } from "next/server";
import { getScheduledTask } from "@/lib/stores/scheduled-tasks";
import { runScheduledTaskNow } from "@/lib/scheduler";

type Params = { params: Promise<{ id: string }> };

// Trigger a scheduled task to fire immediately — same code path as the cron
// poller (publishes a task_completed event, persists the assistant reply,
// advances next_run_at for cron / removes the row for one-shots). Useful for
// previewing notification + content without waiting for the schedule.
//
// Returns 202 immediately and runs the task via `after()` so the client UI
// doesn't have to spin while a full LLM call completes. Progress + success
// + error all surface through the notifications bus (the panel subscribes
// to `/api/v1/events`), so there's no information loss compared to the
// previous awaited path.
export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const task = getScheduledTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  after(async () => {
    try {
      await runScheduledTaskNow(task);
    } catch (err) {
      // runScheduledTaskNow already publishes a failure notification for
      // most failure modes; this catch is the last-resort guard so an
      // unhandled rejection doesn't crash the worker.
      console.error(`[scheduled-tasks/${id}/run] after() task failed:`, err);
    }
  });
  return NextResponse.json({ accepted: true, task_id: id }, { status: 202 });
}
