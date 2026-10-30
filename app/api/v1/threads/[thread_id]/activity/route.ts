/**
 * UI-internal — `GET /api/v1/threads/[thread_id]/activity`
 *
 * One snapshot of what the thread is doing (agent turn phase, queued turns,
 * compaction), polled by the chat so it can show and resume activity that
 * started elsewhere: the scheduler, a watcher, a bridge, or another device.
 */

import { NextRequest, NextResponse } from "next/server";
import { getThread } from "@/lib/stores/threads";
import { getThreadActivity } from "@/lib/agents/thread-activity";
import { errorResponse } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

type Params = { params: Promise<{ thread_id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  if (!getThread(thread_id)) return errorResponse(NOT_FOUND_ERRORS.THREAD, 404);
  return NextResponse.json(getThreadActivity(thread_id), { headers: { "Cache-Control": "no-store" } });
}
