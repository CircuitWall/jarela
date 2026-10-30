/**
 * @public — `GET /api/v1/threads/[thread_id]` (read messages),
 *           `PATCH /api/v1/threads/[thread_id]` (rename / set agent),
 *           `DELETE /api/v1/threads/[thread_id]` (drop thread)
 *
 * Thread-level CRUD. See `docs/api.md`.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteThread,
  getMessagesAfter,
  getMessagesPage,
  getThread,
  type MessageRow,
} from "@/lib/stores/threads";
import { getMessageUsageByIds } from "@/lib/stores/message-usage";
import { collectThreadFileRefNames, removeFilesNoLongerReferenced } from "@/lib/attachments/spill-gc";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { getModelConfig, getModelParams } from "@/lib/stores/model-config";
import { messageToResponse, resolveContextWindowTokens } from "@/lib/api/serializers";
import { currentChannelSummaries, isManualCompactionRunning, pendingCompactionBoundary, pendingCompactionBoundarySeq } from "@/lib/agents/warm-summary-background";
import { parseStoredTopics } from "@/lib/agents/conversation-summary";
import { getThreadActivity } from "@/lib/agents/thread-activity";
import { getCheckpointer } from "@/lib/agents/checkpointer";
import { errorMessage } from "@/lib/utils/error";
import { errorResponse, noStoreJson } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

type Params = { params: Promise<{ thread_id: string }> };

const DEFAULT_PAGE = 50;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 8_192;

function parseSeqParam(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const thread = getThread(thread_id);
  if (!thread) return errorResponse(NOT_FOUND_ERRORS.THREAD, 404);

  const url = new URL(req.url);
  const view = z.enum(["messages", "metadata"]).default("messages")
    .safeParse(url.searchParams.get("view") ?? undefined);
  if (!view.success) return errorResponse("Invalid thread view", 400);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || DEFAULT_PAGE));
  // Cursors are the message `seq` (SQLite rowid) — a monotonic order key,
  // not a timestamp — so pagination can't skip/duplicate rows on a
  // created_at collision.
  const before = parseSeqParam(url.searchParams.get("before"));
  const after  = parseSeqParam(url.searchParams.get("after"));

  // Resolve the agent's effective context-window size once for the whole
  // thread. The bar scales against this cap so the visual matches the
  // budget the agent applies at run time.
  const agentCfg = getAgentConfig(thread.agent_id);
  const modelCfg = agentCfg?.model_config_name ? getModelConfig(agentCfg.model_config_name) : null;
  const modelParams = modelCfg ? getModelParams(modelCfg) : null;
  const rawCtx = modelParams?.context_window_tokens;
  const contextWindowTokens = resolveContextWindowTokens(
    typeof rawCtx === "number" ? rawCtx : null,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
  );

  const metadata = {
    ...thread,
    warm_summary_topics: parseStoredTopics(thread.warm_summary_topics),
    warm_channel_summaries: currentChannelSummaries(thread_id, thread.hot_since_seq),
    context_window_tokens: contextWindowTokens,
    pending_hot_since: pendingCompactionBoundary(thread_id),
    pending_hot_since_seq: pendingCompactionBoundarySeq(thread_id),
    manual_compaction_pending: isManualCompactionRunning(thread_id),
    activity: getThreadActivity(thread_id),
  };
  if (view.data === "metadata") return noStoreJson(metadata);

  // `after` is a forward-fetch shortcut: caller already has the recent
  // messages and just wants the freshly persisted ones.
  let messages: MessageRow[];
  let has_more: boolean;
  if (after !== undefined) {
    messages = getMessagesAfter(thread_id, after, limit);
    has_more = false;
  } else {
    const page = getMessagesPage(thread_id, limit, before);
    messages = page.messages;
    has_more = page.has_more;
  }
  const assistantIds = messages.filter((m) => m.role === "assistant").map((m) => m.msg_id);
  const usageById = getMessageUsageByIds(assistantIds);

  return noStoreJson({
    ...metadata,
    // No server-side filtering: clients receive every message with its
    // `category` tag and apply the chat-panel filter toolbar on the
    // render side. Keeping the raw transcript over the wire means audit
    // history is reachable from any client without round-trip params.
    messages: messages.map((m) => messageToResponse(m, usageById)),
    has_more,
  });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const fileRefs = collectThreadFileRefNames(thread_id);
  const deleted = deleteThread(thread_id);
  if (!deleted) return errorResponse(NOT_FOUND_ERRORS.THREAD, 404);
  removeFilesNoLongerReferenced(fileRefs);

  // Drop the thread's LangGraph checkpoint rows too. Without this the
  // checkpoints.db file grows forever as users delete threads — the rows
  // are orphaned because the per-turn wipe in lib/agents/llm.ts only
  // runs for active threads.
  try {
    await getCheckpointer().deleteThread(thread_id);
  } catch (err) {
    const msg = errorMessage(err);
    if (!/no such table:\s*checkpoints/i.test(msg)) {
      console.error("[threads] checkpoint cleanup failed for thread", thread_id, err);
    }
  }

  return NextResponse.json({ deleted: true });
}
