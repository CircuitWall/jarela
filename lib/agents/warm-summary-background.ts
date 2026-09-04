import { getProvider } from "@/lib/providers";
import { summarizeTranscript, transcriptText } from "@/lib/agents/conversation-summary";
import { unwrapWarmSummary, wrapWarmSummary } from "@/lib/agents/prepare/history-window";
import { getAgentConfig, getAgentTierProportions } from "@/lib/stores/agent-configs";
import { getDefaultModelConfig, getModelConfig, getModelParams } from "@/lib/stores/model-config";
import {
  getRecentMessagesWindow,
  getThread,
  setThreadContextPin,
  setThreadWarmSummary,
} from "@/lib/stores/threads";

const activeRefreshes = new Set<string>();
// Boundaries an automatic compaction has proposed but not yet committed.
// The pin only moves once the recap that replaces the cut-off messages is
// stored, so the turn that proposes it still runs on the old boundary.
const pendingBoundaries = new Map<string, string>();

export function kickWarmSummaryRefresh(threadId: string): void {
  if (!threadId || activeRefreshes.has(threadId)) return;
  activeRefreshes.add(threadId);
  queueMicrotask(() => {
    void refreshWarmSummary(threadId).finally(() => {
      activeRefreshes.delete(threadId);
    });
  });
}

/** ISO boundary an automatic compaction is currently preparing, if any. */
export function pendingCompactionBoundary(threadId: string): string | null {
  return pendingBoundaries.get(threadId) ?? null;
}

/**
 * Prepare an automatic boundary move without applying it yet.
 *
 * Moving the pin first and summarising afterwards leaves exactly one turn
 * with no hot history AND no recap — the window query filters on the new
 * pin, so the messages the recap is supposed to cover aren't even fetched.
 * Commit both together instead: on success the pin and the recap land in
 * the same write, and on failure the thread keeps its full history.
 */
export function kickBoundaryCompaction(threadId: string, boundary: string): void {
  if (!threadId || !boundary) return;
  if (activeRefreshes.has(threadId) || pendingBoundaries.has(threadId)) return;
  const basePin = getThread(threadId)?.hot_since ?? null;
  pendingBoundaries.set(threadId, boundary);
  activeRefreshes.add(threadId);
  queueMicrotask(() => {
    void commitBoundaryCompaction(threadId, boundary, basePin)
      .catch((err) => console.warn(`[context-boundary:auto] compaction failed thread=${threadId}: ${String(err)}`))
      .finally(() => {
        pendingBoundaries.delete(threadId);
        activeRefreshes.delete(threadId);
      });
  });
}

async function commitBoundaryCompaction(
  threadId: string,
  boundary: string,
  basePin: string | null,
): Promise<void> {
  const built = await buildSummaryBefore(threadId, boundary);
  if (!built?.summary) return;
  // The user may have dragged the boundary themselves while we summarised;
  // their pin wins.
  const latest = getThread(threadId);
  if (!latest || (latest.hot_since ?? null) !== basePin) return;
  setThreadContextPin(threadId, boundary);
  setThreadWarmSummary(
    threadId,
    wrapWarmSummary(built.summary, "foreground"),
    boundary,
    built.sourceMessages,
    built.sourceChars,
  );
  console.info(
    `[context-boundary:auto] thread=${threadId} committed boundary=${boundary} warm_msgs=${built.sourceMessages}`,
  );
}

export async function refreshWarmSummary(threadId: string): Promise<void> {
  const thread = getThread(threadId);
  if (!thread?.hot_since) return;
  const boundary = thread.hot_since;

  const built = await buildSummaryBefore(threadId, boundary);
  if (!built) return;
  if (!built.summary) {
    persistIfCurrent(threadId, boundary, "", built.sourceMessages, built.sourceChars);
    return;
  }
  persistIfCurrent(threadId, boundary, built.summary, built.sourceMessages, built.sourceChars);
}

interface BuiltSummary {
  /** Wrapped recap text, or "" when there was too little to summarise. */
  summary: string;
  sourceMessages: number;
  sourceChars: number;
}

/**
 * Summarise every foreground message older than `boundary`. Returns null
 * when the thread/agent/model can't be resolved or the provider produced
 * nothing — callers treat that as "don't touch the stored summary".
 */
async function buildSummaryBefore(threadId: string, boundary: string): Promise<BuiltSummary | null> {
  const thread = getThread(threadId);
  if (!thread) return null;

  const agent = getAgentConfig(thread.agent_id);
  if (!agent) return null;

  const modelName = agent.model_config_name ?? getDefaultModelConfig()?.name ?? null;
  const modelCfg = modelName ? getModelConfig(modelName) : null;
  if (!modelCfg?.provider || !modelCfg.model_id) return null;

  const baseParams = getModelParams(modelCfg);
  const tier = getAgentTierProportions(agent);
  const providerParams = tier ? { ...baseParams, context_tier_proportions: tier } : baseParams;

  const rows = getRecentMessagesWindow(threadId, 0, undefined, "foreground")
    .filter((m) => m.role === "user" || m.role === "assistant");
  const warmRows = rows.filter((m) => m.created_at < boundary);
  const sourceChars = warmRows.reduce((acc, row) => acc + transcriptText(row.content).length, 0);

  if (warmRows.length < 2 || sourceChars < 24) {
    return { summary: "", sourceMessages: warmRows.length, sourceChars };
  }

  const contextTokens = typeof providerParams.context_window_tokens === "number"
    ? providerParams.context_window_tokens
    : 32768;
  const summaryInputChars = Math.max(4000, Math.min(120000, Math.round(contextTokens * 3)));

  const transcript = warmRows
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${transcriptText(m.content)}`)
    .join("\n\n")
    .slice(-summaryInputChars)
    .trim();
  if (!transcript) return null;

  const provider = getProvider(modelCfg.provider);
  const summaryParams = providerParams.max_tokens
    ? providerParams
    : { ...providerParams, max_tokens: 1024 };

  const summary = (await summarizeTranscript(provider, modelCfg.model_id, summaryParams, transcript)).trim();
  if (!summary) return null;

  return {
    summary: [
      "--- Warm context summary ---",
      "Compressed recap of earlier messages outside the hot window:",
      summary,
    ].join("\n"),
    sourceMessages: warmRows.length,
    sourceChars,
  };
}

function persistIfCurrent(
  threadId: string,
  boundary: string,
  summary: string,
  sourceMessages: number,
  sourceChars: number,
): void {
  const latest = getThread(threadId);
  if (!latest || latest.hot_since !== boundary) return;

  if (latest.warm_summary && latest.warm_summary_before === boundary) {
    const cached = unwrapWarmSummary(latest.warm_summary);
    if (cached.scope === "foreground") return;
  }

  setThreadWarmSummary(
    threadId,
    summary ? wrapWarmSummary(summary, "foreground") : "",
    boundary,
    sourceMessages,
    sourceChars,
  );
}
