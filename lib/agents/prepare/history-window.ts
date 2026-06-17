// History-window assembly. Pulls the latest N messages within the agent's
// time bound, computes the context budget, summarises overflow into a warm
// recap, and pulls fact-memory hits relevant to the current turn.
//
// All work is synchronous SQLite + one optional LLM call (for the warm
// summary). The LLM call is best-effort: if the provider errors, we return
// an empty warm context rather than blocking the turn.
//
// See ADR-0039 for the decomposition rationale.

import { getRecentMessagesWindow, getThread, setThreadWarmSummary } from "@/lib/stores/threads";
import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import type { ProviderParams } from "@/lib/providers/types";
import { getConfig } from "@/lib/env/config";
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
import { recall } from "@/lib/embeddings";
import { getProvider } from "@/lib/providers";
import { getKnownContextLength } from "@/lib/providers/known-context-windows";
import type { ContentPart } from "@/lib/tools/types";

export interface ResolvedHistoryWindow {
  history: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>;
  budget: ContextBudget;
  warmSummaryCtx: string;
  factsCtx: string;
  // Per-tier *actual* input-token consumption derived from the assembled
  // window. Lets the chat UI render a diagnostic context-usage bar that
  // shows which tier is starving so the user can rebalance the agent's
  // hot/warm/facts split. Overhead is the system-prompt-side allowance
  // (caller may overwrite with a more precise measurement before persist).
  tierUsage: {
    hot_tokens: number;
    warm_tokens: number;
    facts_tokens: number;
    overhead_tokens: number;
  };
}

/**
 * Build the per-turn history window the LLM sees. Returns the in-prompt
 * message list (already JSON-content-parsed), the context budget, and
 * the warm-summary + facts context strings ready to slot into the system
 * prompt.
 *
 * `hotSince` (ADR-0042) is the user's explicit context boundary. When set,
 * it overrides the agent's `history_window_hours`-derived bound so the
 * boundary line in the chat is the source of truth for what enters hot.
 * When fresh, the cached `warm_summary` on the thread is reused; when the
 * boundary has moved since the last summary was computed (or no summary
 * exists), the warm tier re-summarises and the new text is persisted.
 */
export async function buildHistoryWindow(
  thread_id: string,
  agentCfg: AgentConfigRow,
  providerParams: ProviderParams,
  trimmedMessage: string,
  modelInfo: { providerName?: string; modelId?: string },
  hotSince?: string | null,
): Promise<ResolvedHistoryWindow> {
  const limit = agentCfg.history_limit ?? 50;
  const windowHours = agentCfg.history_window_hours ?? 8;
  // Explicit pin wins over the agent default. NULL/undefined falls back to
  // the time-window heuristic; existing threads with no pin behave exactly
  // as they did before this ADR landed.
  const sinceISO = hotSince
    ? hotSince
    : windowHours > 0
      ? new Date(Date.now() - windowHours * 3600_000).toISOString()
      : undefined;
  const allWindowMessages = getRecentMessagesWindow(thread_id, limit, sinceISO);

  // Reuse the persisted warm summary when the boundary it covers still
  // matches the boundary we'd compute for this turn. The cache is keyed on a
  // boundary string that is either the explicit `hot_since` pin OR — when
  // unpinned — the timestamp of the first hot message, which is the natural
  // cutoff between warm and hot. Without this fallback every unpinned turn
  // paid a full LLM round-trip to re-summarise an unchanged transcript and
  // the result was never persisted, so the summariser tax was permanent.
  const cached = getThread(thread_id);

  const budget = computeContextBudget({
    context_window_tokens:
      typeof providerParams.context_window_tokens === "number"
        ? providerParams.context_window_tokens
        : resolveFallbackContextWindow(modelInfo),
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
      // Boundary key the cached summary is stamped with. Prefer the explicit
      // pin; fall back to the first hot message's timestamp so unpinned
      // threads can also benefit from cache hits across turns that don't
      // change the hot/warm split.
      const hotForSlice = hotMessages ?? takeRecentMessagesWithinBudget(allWindowMessages, budget.tierBudgets.hot);
      const autoBoundary = hotForSlice[0]?.created_at ?? null;
      const boundaryKey = hotSince ?? autoBoundary;
      const cachedSummaryFresh =
        !!cached?.warm_summary
        && boundaryKey !== null
        && cached.warm_summary_before === boundaryKey;
      if (cachedSummaryFresh && cached?.warm_summary) {
        // Boundary-stable turn: don't pay the summariser tax again.
        warmSummaryCtx = cached.warm_summary;
      } else {
        // Race the summariser against a wall-clock budget so a slow or hung
        // provider call cannot permanently stall the chat session. On
        // timeout we fall back to no warm summary — the hot-message truncate
        // path below kicks in so older context isn't silently dropped.
        warmSummaryCtx = await raceWithBudget(
          buildWarmSummary(
            allWindowMessages,
            hotForSlice.length,
            modelInfo.providerName,
            modelInfo.modelId,
            providerParams,
            warmCap,
          ),
          getConfig().warmSummaryBudgetMs,
          "",
        );
        // Persist the freshly-computed summary keyed on the boundary it
        // covers so the chat UI can render it on the next page load and
        // subsequent same-boundary turns short-circuit the LLM call. We
        // persist for both pinned and auto-boundary cases — without this,
        // unpinned threads pay the summariser tax every turn.
        if (warmSummaryCtx && boundaryKey) {
          // Compaction-stat columns: count of messages older than the hot
          // slice + their flattened transcript length. The chat UI shows
          // these on the boundary chip so the user can see the savings.
          const warmMsgCount = Math.max(0, allWindowMessages.length - hotForSlice.length);
          const warmSourceChars = allWindowMessages
            .slice(0, warmMsgCount)
            .reduce((acc, m) => acc + transcriptText(m.content).length, 0);
          setThreadWarmSummary(thread_id, warmSummaryCtx, boundaryKey, warmMsgCount, warmSourceChars);
        }
      }
      const used = estimateTokens(warmSummaryCtx);
      ({ spill } = applyTierSpill(budget.tierBudgets.warm, spill, used));
    } else {
      const factsCap = budget.tierBudgets.facts + spill;
      factsCtx = await buildFactsContext(trimmedMessage, factsCap);
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

  // Re-measure hot AFTER any truncation so the recorded usage matches what
  // actually went into the prompt. Warm/facts are already finalised above.
  const hotTokensFinal = hotMessagesForPrompt.reduce(
    (acc, m) => acc + estimateTokens(transcriptText(m.content)),
    0,
  );

  return {
    history,
    budget,
    warmSummaryCtx,
    factsCtx,
    tierUsage: {
      hot_tokens: hotTokensFinal,
      warm_tokens: estimateTokens(warmSummaryCtx),
      facts_tokens: estimateTokens(factsCtx),
      overhead_tokens: budget.overheadTokens,
    },
  };
}

function sumMessageTokens(messages: readonly MessageRow[]): number {
  return messages.reduce((acc, m) => acc + estimateTokens(transcriptText(m.content)), 0);
}

// When the agent's model config doesn't pin `context_window_tokens`, fall
// back to the web-sourced known-models table keyed by (provider, model_id).
// Returns undefined when the model is unrecognised — the budget calculator
// then uses its hard-coded 8k default.
function resolveFallbackContextWindow(
  modelInfo: { providerName?: string; modelId?: string },
): number | undefined {
  if (!modelInfo.providerName || !modelInfo.modelId) return undefined;
  return getKnownContextLength(modelInfo.providerName, modelInfo.modelId) ?? undefined;
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

// Bounded race: resolve to `promise` when it settles within `ms`, otherwise
// resolve to `fallback`. Mirrors the helper in `lib/agents/run-thread.ts` —
// kept local to avoid widening that module's public surface for one call
// site. A budget of 0 means "wait forever" (the timer fires immediately
// but the promise wins via microtask ordering only if it's already
// settled — in practice we configure non-zero budgets).
function raceWithBudget<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return promise.catch(() => fallback);
  return new Promise<T>((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    promise.then(
      (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } },
      () => { if (!settled) { settled = true; clearTimeout(t); resolve(fallback); } },
    );
  });
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

// Pull the most relevant facts for this turn. Uses semantic recall first
// (cosine over embedded memory_store rows, with a keyword-overlap fallback
// for rows still pending embedding), filtered to namespace=facts. Falls
// back to the cheap substring LIKE on listMemory only when recall returns
// nothing — that path covers the no-embeddings-configured case where the
// stored facts also have no vector, so a verbatim-match query still surfaces
// something useful. recall() may throw if the embedding provider is
// misconfigured; we swallow the error and fall through.
async function buildFactsContext(query: string, factsBudgetTokens: number): Promise<string> {
  if (factsBudgetTokens <= 16) return "";
  if (!query.trim()) return "";
  const charBudget = factsBudgetTokens * 4;

  let hits: Array<{ key: string; value: string }> = [];
  try {
    // Bound the embedding round-trip — a hung provider must not stall the
    // turn. Timeout returns [] which falls through to the substring LIKE
    // path below, same as a thrown error.
    const recalled = await raceWithBudget(recall(query, 30), getConfig().recallBudgetMs, []);
    hits = recalled
      .filter((h) => h.source === "memory" && h.namespace === "facts" && !!h.key)
      .slice(0, 12)
      .map((h) => ({ key: h.key as string, value: h.content }));
  } catch {
    // fall through to LIKE
  }

  if (hits.length === 0) {
    const rows = listMemory("facts", query.slice(0, 120), 12);
    hits = rows.map((r) => ({ key: r.key, value: String(r.value) }));
    if (hits.length === 0) return "";
  }

  const lines = [
    "--- Facts memory ---",
    "Durable fact entries from memory_store namespace=facts:",
  ];
  let used = 0;
  for (const h of hits) {
    const line = `- ${h.key}: ${h.value.slice(0, 220)}`;
    if (used > 0 && used + line.length > charBudget) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length > 2 ? lines.join("\n") : "";
}
