import { getProvider } from "@/lib/providers";
import { summarizeTranscript, transcriptText } from "@/lib/agents/conversation-summary";
import { getAgentConfig, getAgentTierProportions } from "@/lib/stores/agent-configs";
import { getDefaultModelConfig, getModelConfig, getModelParams } from "@/lib/stores/model-config";
import { getMessages, getThread, setThreadWarmSummary } from "@/lib/stores/threads";

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

async function refreshWarmSummary(threadId: string): Promise<void> {
  const thread = getThread(threadId);
  if (!thread?.hot_since) return;

  const agent = getAgentConfig(thread.agent_id);
  if (!agent) return;

  const modelName = agent.model_config_name ?? getDefaultModelConfig()?.name ?? null;
  const modelCfg = modelName ? getModelConfig(modelName) : null;
  if (!modelCfg?.provider || !modelCfg.model_id) return;

  const baseParams = getModelParams(modelCfg);
  const tier = getAgentTierProportions(agent);
  const providerParams = tier ? { ...baseParams, context_tier_proportions: tier } : baseParams;

  const rows = getMessages(threadId).filter((m) => m.role === "user" || m.role === "assistant");
  const warmRows = rows.filter((m) => m.created_at < thread.hot_since!);
  const sourceChars = warmRows.reduce((acc, row) => acc + transcriptText(row.content).length, 0);

  if (warmRows.length < 2 || sourceChars < 24) {
    setThreadWarmSummary(threadId, "", thread.hot_since, warmRows.length, sourceChars);
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

  setThreadWarmSummary(threadId, wrapped, thread.hot_since, warmRows.length, sourceChars);
}
