import { getRun } from "@/lib/agents/run-registry";
import { getQueueDepth } from "@/lib/agents/run-queue";
import { currentCompaction, type CompactionKind } from "@/lib/agents/thread-compaction-state";

/** What a thread is doing right now, as one snapshot the UI can poll. */
export interface ThreadActivity {
  /** The live agent turn, if one is running. */
  run: { phase: string; label: string; started_at: number; agent_id: string | null } | null;
  /** Turns held in the per-thread queue, including one about to start. */
  queue_depth: number;
  /** The most significant compaction running on the thread, if any. */
  compaction: { kind: CompactionKind; boundary_seq: number | null; started_at: number; deadline_at: number } | null;
  busy: boolean;
}

export function getThreadActivity(threadId: string): ThreadActivity {
  const active = getRun(threadId);
  const run = active && active.status === "running"
    ? { phase: active.phase, label: active.phase_label, started_at: active.started_at, agent_id: active.agent_id }
    : null;
  const queue_depth = getQueueDepth(threadId);
  const attempt = currentCompaction(threadId);
  const compaction = attempt
    ? { kind: attempt.kind, boundary_seq: attempt.boundarySeq, started_at: attempt.startedAt, deadline_at: attempt.deadlineAt }
    : null;
  return { run, queue_depth, compaction, busy: run !== null || queue_depth > 0 || compaction !== null };
}
