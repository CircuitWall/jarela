import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getThread, setThreadTaskGoal } from "@/lib/stores/threads";

type Params = { params: Promise<{ thread_id: string }> };

// ADR-0046 — pin or clear the thread's long-task goal. Pass `null` to clear.
// The goal is injected into every subsequent turn's system prompt outside
// the tier budget, so updates take effect on the next run.
const Body = z.object({
  task_goal: z.string().nullable(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const thread = getThread(thread_id);
  if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Body must be { task_goal: string | null }", code: "invalid_body" },
      { status: 400 },
    );
  }

  setThreadTaskGoal(thread_id, parsed.data.task_goal);
  const updated = getThread(thread_id);
  return NextResponse.json({
    task_goal: updated?.task_goal ?? null,
  });
}
