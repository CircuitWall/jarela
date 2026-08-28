import { getAgentConfig } from "@/lib/stores/agent-configs";
import {
  getOrCreateAgentThread,
  getMessages,
  getThread,
  pruneThreadMessages,
} from "@/lib/stores/threads";
import { moveThreadContextBoundary } from "@/lib/agents/context-boundary";
import { getModelConfig, getDefaultModelConfig, getModelParams } from "@/lib/stores/model-config";
import { getProvider } from "@/lib/providers";
import { putMemory, listMemory, deleteMemory } from "@/lib/stores/memory";
import type { ProviderParams } from "@/lib/providers/types";
import { summarizeTranscript, transcriptText } from "@/lib/agents/conversation-summary";
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

export async function compactAgentThread(agentId: string, keepLast = maxThreadMessages()): Promise<ThreadCompactionResult> {
  const agent = getAgentConfig(agentId);
  if (!agent) throw new Error("Agent not found");

  const thread = getOrCreateAgentThread(agentId);
  const rows = getMessages(thread.thread_id);

  if (rows.length < 2) {
    return { compacted: false, reason: "nothing to compact" };
  }

  const cfg = agent.model_config_name
    ? getModelConfig(agent.model_config_name)
    : getDefaultModelConfig();

  if (!cfg) throw new Error("No model configured");

  const providerParams: ProviderParams = getModelParams(cfg);
  const priorSummary = (thread.warm_summary ?? "").trim();
  const priorBefore = thread.warm_summary_before ?? null;
  const priorSourceMessages = thread.warm_summary_source_messages ?? 0;
  const priorSourceChars = thread.warm_summary_source_chars ?? 0;
  const hasPriorSummary = priorSummary.length > 0 && !!priorBefore;

  const newRows = hasPriorSummary
    ? rows.filter((r) => r.created_at > (priorBefore as string))
    : rows;

  if (hasPriorSummary && newRows.length === 0) {
    return { compacted: false, reason: "nothing new since last compact" };
  }

  const flattened = newRows.map((r) => ({
    role: r.role,
    text: transcriptText(r.content),
  }));
  const newTurnsText = flattened
    .map((r) => `${r.role === "user" ? "User" : "Assistant"}: ${r.text}`)
    .join("\n\n");

  const transcript = hasPriorSummary
    ? [
        "Previous compressed memory (preserve every fact, identifier, and decision below):",
        priorSummary,
        "",
        "--- New turns since the above summary ---",
        newTurnsText,
      ].join("\n\n")
    : newTurnsText;

  const newCharCount = newTurnsText.length;
  const contextChars = hasPriorSummary ? priorSourceChars + newCharCount : newCharCount;
  const messageCount = hasPriorSummary ? priorSourceMessages + newRows.length : newRows.length;

  const provider = getProvider(cfg.provider);
  const summary = (await summarizeTranscript(provider, cfg.model_id, providerParams, transcript)).trim();
  if (!summary) return { compacted: false, reason: "empty summary" };

  putMemory("sessions", `${agentId}/${Date.now()}`, {
    summary,
    agent_id: agentId,
    agent_name: agent.name,
    message_count: messageCount,
    compacted_at: new Date().toISOString(),
  });
  const archivePruned = pruneSessionArchives(agentId, maxSessionArchives());

  const lastCreatedAt = rows[rows.length - 1].created_at;
  const lastMs = Date.parse(lastCreatedAt);
  const pinMs = Number.isFinite(lastMs) ? lastMs + 1 : Date.now();
  const newPin = new Date(pinMs).toISOString();

  moveThreadContextBoundary(thread.thread_id, newPin, {
    warmSummary: {
      summary,
      before: newPin,
      sourceMessages: messageCount,
      sourceChars: contextChars,
    },
  });

  const pruned = pruneThreadMessages(thread.thread_id, keepLast);
  const updated = getThread(thread.thread_id);

  return {
    compacted: true,
    summary,
    message_count: messageCount,
    context_chars: contextChars,
    pruned,
    archive_pruned: archivePruned,
    hot_since: updated?.hot_since ?? newPin,
    warm_summary: updated?.warm_summary ?? summary,
    warm_summary_before: updated?.warm_summary_before ?? newPin,
    warm_summary_computed_at: updated?.warm_summary_computed_at ?? null,
    warm_summary_source_messages: updated?.warm_summary_source_messages ?? messageCount,
    warm_summary_source_chars: updated?.warm_summary_source_chars ?? contextChars,
  };
}
