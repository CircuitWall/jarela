import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getThread } from "@/lib/stores/threads";
import { moveThreadContextBoundary } from "@/lib/agents/context-boundary";

type Params = { params: Promise<{ thread_id: string }> };

// ADR-0042. Move the user's hot/warm boundary without sending a turn. The
// summary refresh is kicked off asynchronously in background so the drag stays
// snappy and the updated warm recap appears shortly after commit.
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

  const updated = moveThreadContextBoundary(thread_id, parsed.data.hot_since, { refreshWarmSummary: true });
  return NextResponse.json({
    hot_since: updated?.hot_since ?? null,
    warm_summary: updated?.warm_summary ?? null,
    warm_summary_before: updated?.warm_summary_before ?? null,
    warm_summary_computed_at: updated?.warm_summary_computed_at ?? null,
    warm_summary_source_messages: updated?.warm_summary_source_messages ?? null,
    warm_summary_source_chars: updated?.warm_summary_source_chars ?? null,
  });
}
