import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getThread, getThreadMessageBySeq } from "@/lib/stores/threads";
import { moveThreadContextBoundary } from "@/lib/agents/context-boundary";
import { currentChannelSummaries, pendingCompactionBoundary, pendingCompactionBoundarySeq } from "@/lib/agents/warm-summary-background";
import { parseStoredTopics } from "@/lib/agents/conversation-summary";
import { errorResponse, errorJson } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

type Params = { params: Promise<{ thread_id: string }> };

// ADR-0042. Move the user's hot/warm boundary without sending a turn. The
// summary refresh is kicked off asynchronously in background so the drag stays
// snappy and the updated warm recap appears shortly after commit.
const Body = z.object({
  hot_since_seq: z.number().int().positive().nullable(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const thread = getThread(thread_id);
  if (!thread) return errorResponse(NOT_FOUND_ERRORS.THREAD, 404);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorJson({ error: "Body must be { hot_since_seq: number | null }", code: "invalid_body" }, { status: 400 });
  }

  const requestedSeq = parsed.data.hot_since_seq;
  const source = typeof requestedSeq === "number" ? getThreadMessageBySeq(thread_id, requestedSeq) : null;
  if (typeof requestedSeq === "number" && !source) {
    return errorJson({ error: "Boundary seq does not belong to this thread", code: "invalid_boundary" }, { status: 400 });
  }
  const updated = moveThreadContextBoundary(thread_id, requestedSeq, { refreshWarmSummary: true });
  return NextResponse.json({
    hot_since: updated?.hot_since ?? null,
    hot_since_seq: updated?.hot_since_seq ?? null,
    warm_summary: updated?.warm_summary ?? null,
    warm_summary_before: updated?.warm_summary_before ?? null,
    warm_summary_before_seq: updated?.warm_summary_before_seq ?? null,
    warm_summary_computed_at: updated?.warm_summary_computed_at ?? null,
    warm_summary_source_messages: updated?.warm_summary_source_messages ?? null,
    warm_summary_source_chars: updated?.warm_summary_source_chars ?? null,
    warm_summary_topics: parseStoredTopics(updated?.warm_summary_topics),
    warm_channel_summaries: currentChannelSummaries(thread_id, updated?.hot_since_seq),
    pending_hot_since: pendingCompactionBoundary(thread_id),
    pending_hot_since_seq: pendingCompactionBoundarySeq(thread_id),
  });
}
