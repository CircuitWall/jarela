import { NextRequest, NextResponse } from "next/server";
import { getScheduledTask } from "@/lib/stores/scheduled-tasks";
import { runScheduledTaskNow } from "@/lib/scheduler";

type Params = { params: Promise<{ id: string }> };

// Trigger a scheduled task to fire immediately — same code path as the cron
// poller (publishes a task_completed event, persists the assistant reply,
// advances next_run_at for cron / removes the row for one-shots). Useful for
// previewing notification + content without waiting for the schedule.
export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const task = getScheduledTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    await runScheduledTaskNow(task);
    return NextResponse.json({ ran: true, task_id: id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
