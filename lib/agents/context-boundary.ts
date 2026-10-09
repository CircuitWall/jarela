import { getThread, getThreadMessageBySeq, setThreadContextPin, setAutoBoundaryLock } from "@/lib/stores/threads";
import { kickBoundaryCompaction } from "@/lib/agents/warm-summary-background";

// Every caller of moveThreadContextBoundary represents a user-initiated
// boundary change (drag the line, the manual /compact command, or the agent's
// compact_context tool acting on the user's say-so) — the
// auto-detector's own commit (lib/agents/warm-summary-background.ts
// commitBoundaryCompaction) calls setThreadContextPin directly instead, so
// it never re-arms this lock. Suppresses the hot-turn-limit compaction in
// lib/agents/run-thread.ts for the next N eligible turns so a manual
// choice doesn't get silently re-moved on the very next turn.
// Counted in messages (~2 per turn: one user + one assistant row) since
// that's what's already on the thread row — no extra query or per-turn
// write needed to check it.
const MANUAL_PIN_COOLDOWN_TURNS = 5;
const MESSAGES_PER_TURN = 2;

export interface MoveThreadContextBoundaryOptions {
  refreshWarmSummary?: boolean;
  warmSummary?: {
    summary: string;
    before: string | null;
    sourceMessages?: number | null;
    sourceChars?: number | null;
    topics?: string | null;
  };
}

export function moveThreadContextBoundary(
  threadId: string,
  boundarySeq: number | null,
  options: MoveThreadContextBoundaryOptions = {},
) {
  // Do not expose a narrower hot query before its replacement warm context
  // exists. The background coordinator publishes both in one transaction.
  if (boundarySeq !== null && options.refreshWarmSummary) {
    const currentCount = getThread(threadId)?.message_count ?? 0;
    kickBoundaryCompaction(threadId, boundarySeq, {
      autoBoundaryLockedUntilMessageCount: currentCount + MANUAL_PIN_COOLDOWN_TURNS * MESSAGES_PER_TURN,
    });
    return getThread(threadId);
  }

  const source = boundarySeq === null ? null : getThreadMessageBySeq(threadId, boundarySeq);
  if (boundarySeq !== null && !source) throw new Error("Boundary seq does not belong to this thread");
  setThreadContextPin(threadId, source?.created_at ?? null, boundarySeq);
  // Clearing the pin (hotSince=null) means the user wants auto-detection
  // back in full control right away — clear the lock instead of arming it.
  // Only an actual manual placement earns a cooldown.
  const currentCount = getThread(threadId)?.message_count ?? 0;
  setAutoBoundaryLock(threadId, boundarySeq !== null ? currentCount + MANUAL_PIN_COOLDOWN_TURNS * MESSAGES_PER_TURN : 0);
  return getThread(threadId);
}