import { getThread, setThreadContextPin, setAutoBoundaryLock } from "@/lib/stores/threads";
import { kickBoundaryCompaction } from "@/lib/agents/warm-summary-background";

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
  // Do not expose a narrower hot query before its replacement warm context
  // exists. The background coordinator publishes both in one transaction.
  if (hotSince && options.refreshWarmSummary) {
    const currentCount = getThread(threadId)?.message_count ?? 0;
    kickBoundaryCompaction(threadId, hotSince, {
      autoBoundaryLockedUntilMessageCount: currentCount + MANUAL_PIN_COOLDOWN_TURNS * MESSAGES_PER_TURN,
    });
    return getThread(threadId);
  }

  setThreadContextPin(threadId, hotSince);
  // Clearing the pin (hotSince=null) means the user wants auto-detection
  // back in full control right away — clear the lock instead of arming it.
  // Only an actual manual placement earns a cooldown.
  const currentCount = getThread(threadId)?.message_count ?? 0;
  setAutoBoundaryLock(threadId, hotSince ? currentCount + MANUAL_PIN_COOLDOWN_TURNS * MESSAGES_PER_TURN : 0);
  return getThread(threadId);
}