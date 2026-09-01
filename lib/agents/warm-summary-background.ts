import { getProvider } from "@/lib/providers";
import { summarizeTranscript, transcriptText } from "@/lib/agents/conversation-summary";
import { unwrapWarmSummary, wrapWarmSummary } from "@/lib/agents/prepare/history-window";
import { getAgentConfig, getAgentTierProportions } from "@/lib/stores/agent-configs";
import { getDefaultModelConfig, getModelConfig, getModelParams } from "@/lib/stores/model-config";
import { getRecentMessagesWindow, getThread, setThreadWarmSummary } from "@/lib/stores/threads";

const activeRefreshes = new Set<string>();

export function kickWarmSummaryRefresh(threadId: string): void {
  if (!threadId || activeRefreshes.has(threadId)) return;
  activeRefreshes.add(threadId);
  queueMicrotask(() => {
    void refreshWarmSummary(threadId).finally(() => {
      activeRefreshes.delete(threadId);
    });
  });
}

export async function refreshWarmSummary(threadId: string): Promise<void> {
  const thread = getThread(threadId);
  if (!thread?.hot_since) return;
  const boundary = thread.hot_since;

  const agent = getAgentConfig(thread.agent_id);
  if (!agent) return;

  const modelName = agent.model_config_name ?? getDefaultModelConfig()?.name ?? null;
  const modelCfg = modelName ? getModelConfig(modelName) : null;
  if (!modelCfg?.provider || !modelCfg.model_id) return;

  const baseParams = getModelParams(modelCfg);
  const tier = getAgentTierProportions(agent);
  const providerParams = tier ? { ...baseParams, context_tier_proportions: tier } : baseParams;

  const rows = getRecentMessagesWindow(threadId, 0, undefined, "foreground")
    .filter((m) => m.role === "user" || m.role === "assistant");
  const warmRows = rows.filter((m) => m.created_at < boundary);
  const sourceChars = warmRows.reduce((acc, row) => acc + transcriptText(row.content).length, 0);

  if (warmRows.length < 2 || sourceChars < 24) {
    persistIfCurrent(threadId, boundary, "", warmRows.length, sourceChars);
    return;
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
  if (!transcript) return;

  const provider = getProvider(modelCfg.provider);
  const summaryParams = providerParams.max_tokens
    ? providerParams
    : { ...providerParams, max_tokens: 1024 };

  const summary = (await summarizeTranscript(provider, modelCfg.model_id, summaryParams, transcript)).trim();
  if (!summary) return;

  const wrapped = [
    "--- Warm context summary ---",
    "Compressed recap of earlier messages outside the hot window:",
    summary,
  ].join("\n");

  persistIfCurrent(threadId, boundary, wrapped, warmRows.length, sourceChars);
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
