import { getThread, setThreadContextPin, setThreadWarmSummary } from "@/lib/stores/threads";
import { kickWarmSummaryRefresh } from "@/lib/agents/warm-summary-background";

export interface MoveThreadContextBoundaryOptions {
  refreshWarmSummary?: boolean;
  warmSummary?: {
    summary: string;
    before: string | null;
    sourceMessages?: number | null;
    sourceChars?: number | null;
  };
}

export function moveThreadContextBoundary(
  threadId: string,
  hotSince: string | null,
  options: MoveThreadContextBoundaryOptions = {},
) {
  setThreadContextPin(threadId, hotSince);
  if (options.warmSummary) {
    setThreadWarmSummary(
      threadId,
      options.warmSummary.summary,
      options.warmSummary.before,
      options.warmSummary.sourceMessages,
      options.warmSummary.sourceChars,
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