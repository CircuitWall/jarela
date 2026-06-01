// History-window assembly. Pulls the latest N messages within the agent's
// time bound, computes the context budget, summarises overflow into a warm
// recap, and pulls fact-memory hits relevant to the current turn.
//
// All work is synchronous SQLite + one optional LLM call (for the warm
// summary). The LLM call is best-effort: if the provider errors, we return
// an empty warm context rather than blocking the turn.
//
// See ADR-0039 for the decomposition rationale.

import { getRecentMessagesWindow } from "@/lib/stores/threads";
import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import type { ProviderParams } from "@/lib/providers/types";
import {
  applyTierSpill,
  computeContextBudget,
  estimateTokens,
  takeRecentMessagesWithinBudget,
  truncateLargestMessagesWithinBudget,
  type ContextBudget,
} from "@/lib/agents/context-budget";
import { summarizeTranscript, transcriptText } from "@/lib/agents/conversation-summary";
import type { MessageRow } from "@/lib/stores/threads";
import { listMemory } from "@/lib/stores/memory";
import { getProvider } from "@/lib/providers";
import type { ContentPart } from "@/lib/tools/types";

export interface ResolvedHistoryWindow {
  history: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>;
  budget: ContextBudget;
  warmSummaryCtx: string;
  factsCtx: string;
}

/**
 * Build the per-turn history window the LLM sees. Returns the in-prompt
 * message list (already JSON-content-parsed), the context budget, and
 * the warm-summary + facts context strings ready to slot into the system
 * prompt.
 */
export async function buildHistoryWindow(
  thread_id: string,
  agentCfg: AgentConfigRow,
  providerParams: ProviderParams,
  trimmedMessage: string,
  modelInfo: { providerName?: string; modelId?: string },
): Promise<ResolvedHistoryWindow> {
  const limit = agentCfg.history_limit ?? 50;
  const windowHours = agentCfg.history_window_hours ?? 8;
  const sinceISO = windowHours > 0
    ? new Date(Date.now() - windowHours * 3600_000).toISOString()
    : undefined;
  const allWindowMessages = getRecentMessagesWindow(thread_id, limit, sinceISO);

  const budget = computeContextBudget({
    context_window_tokens:
      typeof providerParams.context_window_tokens === "number"
        ? providerParams.context_window_tokens
        : undefined,
    max_tokens: typeof providerParams.max_tokens === "number" ? providerParams.max_tokens : undefined,
    context_tier_proportions:
      typeof providerParams.context_tier_proportions === "object" && providerParams.context_tier_proportions
        ? (providerParams.context_tier_proportions as { hot?: number; warm?: number; facts?: number })
        : undefined,
    context_tier_priority: providerParams.context_tier_priority,
  });

  // Walk tiers in the configured priority order, threading the unused-token
  // spill from each tier into the next so leftover headroom isn't wasted.
  // Default priority [hot, warm, facts] makes this identical to the natural
  // data-flow order; non-default priorities still respect the data-flow
  // dependency (warm needs hot's slice) by falling back to hot's soft cap
  // when warm is asked to evaluate before hot has run.
  let spill = 0;
  let hotMessages: MessageRow[] | undefined;
  let hotCap = 0;
  let warmSummaryCtx = "";
  let factsCtx = "";

  for (const tier of budget.tierPriority) {
    if (tier === "hot") {
      ({ cap: hotCap } = applyTierSpill(budget.tierBudgets.hot, spill, 0));
      hotMessages = takeRecentMessagesWithinBudget(allWindowMessages, hotCap);
      const used = sumMessageTokens(hotMessages);
      ({ spill } = applyTierSpill(budget.tierBudgets.hot, spill, used));
    } else if (tier === "warm") {
      const warmCap = budget.tierBudgets.warm + spill;
      // If priority evaluates warm before hot, do a provisional hot slice at
      // hot's soft cap so we know which messages to summarise. Hot's later
      // pass may then absorb more (its cap will include any warm spill back),
      // and the warm summary will harmlessly cover a few messages hot also
      // includes — better than not summarising at all.
      const hotForSlice = hotMessages ?? takeRecentMessagesWithinBudget(allWindowMessages, budget.tierBudgets.hot);
      warmSummaryCtx = await buildWarmSummary(
        allWindowMessages,
        hotForSlice.length,
        modelInfo.providerName,
        modelInfo.modelId,
        providerParams,
        warmCap,
      );
      const used = estimateTokens(warmSummaryCtx);
      ({ spill } = applyTierSpill(budget.tierBudgets.warm, spill, used));
    } else {
      const factsCap = budget.tierBudgets.facts + spill;
      factsCtx = buildFactsContext(trimmedMessage, factsCap);
      const used = estimateTokens(factsCtx);
      ({ spill } = applyTierSpill(budget.tierBudgets.facts, spill, used));
    }
  }

  // Hot is always evaluated above (priority always contains all three tiers),
  // but TypeScript can't see that. Default to an empty list defensively.
  const hotMessagesResolved = hotMessages ?? [];

  // If the warm tier was expected but failed to summarise, fall back to
  // truncating the largest hot messages so the older context isn't silently
  // dropped — better to clip overlong messages than lose them entirely.
  const warmWasExpected = budget.tierBudgets.warm > 32 && (allWindowMessages.length - hotMessagesResolved.length) >= 2;
  const hotMessagesForPrompt = !warmSummaryCtx && warmWasExpected
    ? truncateLargestMessagesWithinBudget(hotMessagesResolved, hotCap || budget.tierBudgets.hot)
    : hotMessagesResolved;

  const history = hotMessagesForPrompt.map((m) => ({
    role: m.role as "user" | "assistant",
    content: parseContent(m.content),
  }));

  return { history, budget, warmSummaryCtx, factsCtx };
}

function sumMessageTokens(messages: readonly MessageRow[]): number {
  return messages.reduce((acc, m) => acc + estimateTokens(transcriptText(m.content)), 0);
}

// Recover ContentPart[] from messages that were stored as JSON-encoded
// arrays (text + attachments). Plain string messages pass through.
function parseContent(raw: string): string | ContentPart[] {
  if (!raw.startsWith("[")) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      typeof parsed[0] === "object" &&
      parsed[0] !== null &&
      "type" in (parsed[0] as object)
    ) {
      return parsed as ContentPart[];
    }
  } catch {
    // not valid JSON — treat as plain text
  }
  return raw;
}

async function buildWarmSummary(
  allWindowMessages: readonly { role: string; content: string }[],
  hotCount: number,
  providerName: string | undefined,
  modelId: string | undefined,
  providerParams: ProviderParams,
  warmBudgetTokens: number,
): Promise<string> {
  if (warmBudgetTokens <= 32) return "";
  if (!providerName || !modelId) return "";
  const warmMessages = allWindowMessages.slice(0, Math.max(0, allWindowMessages.length - hotCount));
  if (warmMessages.length < 2) return "";

  // Keep summary input bounded by the warm budget to avoid recursive prompt bloat.
  const summaryInputChars = Math.max(0, warmBudgetTokens * 4);
  const transcript = warmMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${transcriptText(m.content)}`)
    .join("\n\n")
    .slice(-summaryInputChars);
  if (!transcript.trim()) return "";

  try {
    const provider = getProvider(providerName);
    const summary = await summarizeTranscript(provider, modelId, providerParams, transcript);
    if (!summary) return "";
    return [
      "--- Warm context summary ---",
      "Compressed recap of earlier messages outside the hot window:",
      summary,
    ].join("\n");
  } catch {
    return "";
  }
}

function buildFactsContext(query: string, factsBudgetTokens: number): string {
  if (factsBudgetTokens <= 16) return "";
  const charBudget = factsBudgetTokens * 4;
  const rows = listMemory("facts", query.slice(0, 120), 12);
  if (rows.length === 0) return "";

  const lines = [
    "--- Facts memory ---",
    "Durable fact entries from memory_store namespace=facts:",
  ];
  let used = 0;
  for (const row of rows) {
    const line = `- ${row.key}: ${String(row.value).slice(0, 220)}`;
    if (used > 0 && used + line.length > charBudget) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length > 2 ? lines.join("\n") : "";
}
