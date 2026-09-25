import { getAgentConfig } from "@/lib/stores/agent-configs";
import {
  getOrCreateAgentThread,
  getMessages,
  getThread,
  pruneThreadMessages,
} from "@/lib/stores/threads";
import { putMemory, listMemory, deleteMemory } from "@/lib/stores/memory";
import { compactThreadWarmContext } from "@/lib/agents/warm-summary-background";
import { getConfig } from "@/lib/env/config";

export type ThreadCompactionResult =
  | { compacted: false; reason: string }
  | {
      compacted: true;
      summary: string;
      message_count: number;
      context_chars: number;
      pruned: number;
      archive_pruned: number;
      hot_since: string;
      warm_summary: string;
      warm_summary_before: string;
      warm_summary_computed_at: string | null;
      warm_summary_source_messages: number;
      warm_summary_source_chars: number;
      warm_summary_topics: string | null;
    };

function maxThreadMessages(): number {
  return getConfig().maxThreadMessages;
}

function maxSessionArchives(): number {
  return getConfig().maxSessionArchives;
}

export function autoCompactionKeepLast(cap: number): number {
  return Math.max(1, cap - Math.max(20, Math.ceil(cap * 0.1)));
}

function timestampAfter(timestamp: string): string {
  const millis = Date.parse(timestamp);
  return Number.isFinite(millis) ? new Date(millis + 1).toISOString() : timestamp;
}

function pruneSessionArchives(agentId: string, keepLast: number): number {
  const prefix = `${agentId}/`;
  const all = listMemory("sessions", undefined, 10_000)
    .filter((r) => r.key.startsWith(prefix))
    .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));
  if (all.length <= keepLast) return 0;
  const drop = all.slice(0, all.length - keepLast);
  let removed = 0;
  for (const row of drop) {
    if (deleteMemory("sessions", row.key)) removed++;
  }
  return removed;
}

export async function compactAgentThread(
  agentId: string,
  keepLast = maxThreadMessages(),
  resetContext = false,
): Promise<ThreadCompactionResult> {
  const agent = getAgentConfig(agentId);
  if (!agent) throw new Error("Agent not found");

  const thread = getOrCreateAgentThread(agentId);
  const rows = getMessages(thread.thread_id);

  if (rows.length === 0) {
    return { compacted: false, reason: "nothing to compact" };
  }

  const fullSessionReset = resetContext || keepLast >= rows.length;
  const lastRow = rows[rows.length - 1];
  const boundaryRow = fullSessionReset ? null : rows[Math.max(0, rows.length - keepLast)] ?? lastRow;
  const rawBoundary = fullSessionReset ? timestampAfter(lastRow.created_at) : boundaryRow!.created_at;
  // `rawBoundary` is a created_at value (ADR-0042 persists hot_since/
  // warm_summary_before as timestamps), but WHICH rows this round actually
  // prunes must be exact — a same-millisecond collision at the boundary
  // would otherwise tie under `<` and get silently skipped (see ADR-0088).
  // Pass the exact row's `seq` through so compactThreadWarmContext can
  // return an equally exact `boundarySeq` for the destructive prune below,
  // instead of the caller re-deriving one from the created_at string.
  const requestedBoundarySeq = fullSessionReset ? lastRow.seq + 1 : boundaryRow!.seq;
  const context = await compactThreadWarmContext(thread.thread_id, rawBoundary, {
    expectedHotSince: thread.hot_since ?? null,
    alignTopicBoundary: !fullSessionReset,
    requestedBoundarySeq,
  });
  if (!context) return { compacted: false, reason: "summary was not committed" };

  putMemory("sessions", `${agentId}/${Date.now()}`, {
    summary: context.summary,
    agent_id: agentId,
    agent_name: agent.name,
    message_count: context.sourceMessages,
    compacted_at: new Date().toISOString(),
  });
  const archivePruned = pruneSessionArchives(agentId, maxSessionArchives());

  const pruned = pruneThreadMessages(thread.thread_id, keepLast, context.boundarySeq ?? requestedBoundarySeq);
  const updated = getThread(thread.thread_id);

  return {
    compacted: true,
    summary: context.summary,
    message_count: context.sourceMessages,
    context_chars: context.sourceChars,
    pruned,
    archive_pruned: archivePruned,
    hot_since: updated?.hot_since ?? context.boundary,
    warm_summary: updated?.warm_summary ?? context.summary,
    warm_summary_before: updated?.warm_summary_before ?? context.boundary,
    warm_summary_computed_at: updated?.warm_summary_computed_at ?? null,
    warm_summary_source_messages: updated?.warm_summary_source_messages ?? context.sourceMessages,
    warm_summary_source_chars: updated?.warm_summary_source_chars ?? context.sourceChars,
    warm_summary_topics: updated?.warm_summary_topics ?? (context.topics.length > 0 ? JSON.stringify(context.topics) : null),
  };
}
