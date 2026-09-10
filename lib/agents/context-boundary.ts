import { getThread, setThreadContextPin, setThreadWarmSummary, setAutoBoundaryLock } from "@/lib/stores/threads";
import { kickWarmSummaryRefresh } from "@/lib/agents/warm-summary-background";

// Every caller of moveThreadContextBoundary represents a user-initiated
// boundary change (drag the line, or the manual /compact command) — the
// auto-detector's own commit (lib/agents/warm-summary-background.ts
// commitBoundaryCompaction) calls setThreadContextPin directly instead, so
// it never re-arms this lock. Suppresses maybeAutoContextBoundary in
// lib/agents/run-thread.ts for the next N eligible turns so a manual
// choice doesn't get silently re-moved on the very next idle+shift turn.
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
  hotSince: string | null,
  options: MoveThreadContextBoundaryOptions = {},
) {
  setThreadContextPin(threadId, hotSince);
  // Clearing the pin (hotSince=null) means the user wants auto-detection
  // back in full control right away — clear the lock instead of arming it.
  // Only an actual manual placement earns a cooldown.
  const currentCount = getThread(threadId)?.message_count ?? 0;
  setAutoBoundaryLock(threadId, hotSince ? currentCount + MANUAL_PIN_COOLDOWN_TURNS * MESSAGES_PER_TURN : 0);
  if (options.warmSummary) {
    setThreadWarmSummary(
      threadId,
      options.warmSummary.summary,
      options.warmSummary.before,
      options.warmSummary.sourceMessages,
      options.warmSummary.sourceChars,
      options.warmSummary.topics,
    );
  }
  const updated = getThread(threadId);
  if (
    options.refreshWarmSummary
    && hotSince
    && updated?.warm_summary_before !== hotSince
  ) {
    kickWarmSummaryRefresh(threadId);
  }
  return updated;
}