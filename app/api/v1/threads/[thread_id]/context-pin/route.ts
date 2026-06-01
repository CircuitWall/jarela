import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getThread, setThreadContextPin } from "@/lib/stores/threads";

type Params = { params: Promise<{ thread_id: string }> };

// ADR-0042. Move the user's hot/warm boundary without sending a turn. The
// summary is NOT recomputed here — that's lazy, on the next POST /run. The
// chat UI shows a placeholder card in the meantime so the user gets instant
// feedback for the drag.
const Body = z.object({
  hot_since: z.string().nullable(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const thread = getThread(thread_id);
  if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Body must be { hot_since: string | null }", code: "invalid_body" },
      { status: 400 },
    );
  }

  setThreadContextPin(thread_id, parsed.data.hot_since);
  const updated = getThread(thread_id);
  return NextResponse.json({
    hot_since: updated?.hot_since ?? null,
    warm_summary: updated?.warm_summary ?? null,
    warm_summary_before: updated?.warm_summary_before ?? null,
    warm_summary_computed_at: updated?.warm_summary_computed_at ?? null,
  });
}
