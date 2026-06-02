// History-window assembly. Pulls the latest N messages within the agent's
// time bound, computes the context budget, summarises overflow into a warm
// recap, and pulls fact-memory hits relevant to the current turn.
//
// All work is synchronous SQLite + one optional LLM call (for the warm
// summary). The LLM call is best-effort: if the provider errors, we return
// an empty warm context rather than blocking the turn.
//
// See ADR-0039 for the decomposition rationale.

import {
  getRecentMessagesWindow,
  getThread,
  setThreadWarmSummary,
  setThreadWarmSummaryStatus,
  type WarmSummaryStatus,
} from "@/lib/stores/threads";
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
import { summarizeTranscriptWithRetry, transcriptText } from "@/lib/agents/conversation-summary";
import type { MessageRow } from "@/lib/stores/threads";
import { listMemory, putMemory } from "@/lib/stores/memory";
import { extractFactsFromTranscript } from "@/lib/agents/fact-extraction";
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
  // PR-2 — compaction status reported by the warm tier this turn. Null when
  // the warm tier didn't run (e.g. budget too small or no messages outside
  // the hot slice). The route persists this onto the thread so the chat UI
  // can render a "warm context degraded" chip when status === 'failed'.
  warmSummaryStatus: WarmSummaryStatus | null;
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
  // matches the current pin — saves an LLM call on every turn that doesn't
  // change the boundary.
  const cached = hotSince ? getThread(thread_id) : null;
  const cachedSummaryFresh =
    !!cached?.warm_summary && cached.warm_summary_before === hotSince;

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
  let warmSummaryStatus: WarmSummaryStatus | null = null;

  for (const tier of budget.tierPriority) {
    if (tier === "hot") {
      ({ cap: hotCap } = applyTierSpill(budget.tierBudgets.hot, spill, 0));
      hotMessages = takeRecentMessagesWithinBudget(allWindowMessages, hotCap);
      const used = sumMessageTokens(hotMessages);
      ({ spill } = applyTierSpill(budget.tierBudgets.hot, spill, used));
    } else if (tier === "warm") {
      const warmCap = budget.tierBudgets.warm + spill;
      if (cachedSummaryFresh && cached?.warm_summary) {
        // Pin-stable turn: don't pay the summariser tax again.
        warmSummaryCtx = cached.warm_summary;
        warmSummaryStatus = "fresh";
      } else {
        // If priority evaluates warm before hot, do a provisional hot slice at
        // hot's soft cap so we know which messages to summarise. Hot's later
        // pass may then absorb more (its cap will include any warm spill back),
        // and the warm summary will harmlessly cover a few messages hot also
        // includes — better than not summarising at all.
        const hotForSlice = hotMessages ?? takeRecentMessagesWithinBudget(allWindowMessages, budget.tierBudgets.hot);
        const summaryResult = await buildWarmSummary(
          allWindowMessages,
          hotForSlice.length,
          modelInfo.providerName,
          modelInfo.modelId,
          providerParams,
          warmCap,
        );
        warmSummaryCtx = summaryResult.text;
        warmSummaryStatus = summaryResult.status;
        // Persist the freshly-computed summary keyed on the boundary it
        // covers, so the chat UI can render it on the next page load and
        // subsequent same-pin turns can short-circuit the LLM call. Skipped
        // when there's no explicit pin because the time-windowed boundary
        // shifts every turn — caching it would never hit. setThreadWarmSummary
        // also stamps status='fresh' for free.
        if (warmSummaryCtx && hotSince) {
          setThreadWarmSummary(thread_id, warmSummaryCtx, hotSince);
        } else if (summaryResult.status === "failed" && hotSince) {
          // Failed retry budget: keep any prior cached summary intact (it's
          // better than nothing) but flag the thread so the UI can show
          // degraded compaction. Without a pin we can't persist the status
          // safely (the boundary the would-be record covers is undefined).
          setThreadWarmSummaryStatus(thread_id, "failed");
        }
        // ADR-0046 — fact graduation. Same boundary-move trigger as the
        // summary itself: we only run extraction when fresh content is
        // being evicted into the warm tier, not on every turn. The pass
        // is best-effort and never throws — it can only ADD to memory,
        // not corrupt the main turn.
        if (warmSummaryCtx && hotSince && modelInfo.providerName && modelInfo.modelId) {
          await graduateFactsFromEvicted(
            allWindowMessages,
            hotForSlice.length,
            modelInfo.providerName,
            modelInfo.modelId,
            providerParams,
            warmCap,
          );
        }
      }
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
    warmSummaryStatus,
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

interface WarmSummaryOutcome {
  text: string;
  // 'fresh' on success; 'failed' when every retry attempt errored. Null
  // when the warm tier was a no-op (budget too small, no warm messages,
  // missing provider/model) — these aren't degradation, they're "the
  // tier wasn't engaged this turn".
  status: WarmSummaryStatus | null;
}

async function buildWarmSummary(
  allWindowMessages: readonly { role: string; content: string }[],
  hotCount: number,
  providerName: string | undefined,
  modelId: string | undefined,
  providerParams: ProviderParams,
  warmBudgetTokens: number,
): Promise<WarmSummaryOutcome> {
  if (warmBudgetTokens <= 32) return { text: "", status: null };
  if (!providerName || !modelId) return { text: "", status: null };
  const warmMessages = allWindowMessages.slice(0, Math.max(0, allWindowMessages.length - hotCount));
  if (warmMessages.length < 2) return { text: "", status: null };

  // Keep summary input bounded by the warm budget to avoid recursive prompt bloat.
  const summaryInputChars = Math.max(0, warmBudgetTokens * 4);
  const transcript = warmMessages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${transcriptText(m.content)}`)
    .join("\n\n")
    .slice(-summaryInputChars);
  if (!transcript.trim()) return { text: "", status: null };

  // Retry-with-backoff (PR-2 #A). The previous catch-and-empty silently lost
  // older context across long tasks every time the provider hiccuped. Two
  // attempts are usually enough to ride through transient failures without
  // doubling cost on the steady-state turn.
  const provider = getProvider(providerName);
  const result = await summarizeTranscriptWithRetry(provider, modelId, providerParams, transcript);
  if (!result.text) {
    // Every attempt failed. Log so operators can correlate UI degradation
    // with the underlying provider error.
    console.warn(
      `[warm-summary] giving up after ${result.attempts} attempt(s) on ${providerName}/${modelId}:`,
      result.lastError,
    );
    return { text: "", status: "failed" };
  }
  return {
    text: [
      "--- Warm context summary ---",
      "Compressed recap of earlier messages outside the hot window:",
      result.text,
    ].join("\n"),
    status: "fresh",
  };
}

// ADR-0046 — fact graduation. When the warm summary is being recomputed at
// a moved boundary, the messages being evicted have one last chance to
// contribute durable facts to long-term memory. Without this pass, every
// boundary move re-summarises the same key facts forever; with it, they
// graduate into memory_store namespace=facts and stop competing for warm
// tokens on every subsequent turn.
//
// Best-effort: parse failures, low confidence, or model errors all just
// produce a no-op. Conservative on what we keep — see fact-extraction.ts.
async function graduateFactsFromEvicted(
  allWindowMessages: readonly { role: string; content: string }[],
  hotCount: number,
  providerName: string,
  modelId: string,
  providerParams: ProviderParams,
  warmBudgetTokens: number,
): Promise<void> {
  const evicted = allWindowMessages.slice(0, Math.max(0, allWindowMessages.length - hotCount));
  if (evicted.length < 2) return;

  // Bound the input the same way warm summarisation does — extraction
  // benefits from broad context but the LLM cost has to stay reasonable.
  const charBudget = Math.max(0, warmBudgetTokens * 4);
  const transcript = evicted
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${transcriptText(m.content)}`)
    .join("\n\n")
    .slice(-charBudget);
  if (!transcript.trim()) return;

  try {
    const provider = getProvider(providerName);
    const facts = await extractFactsFromTranscript(provider, modelId, providerParams, transcript);
    for (const f of facts) {
      try {
        // Idempotent: putMemory upserts on (namespace, key). Re-graduating
        // the same fact across boundary moves just refreshes its
        // updated_at + re-embeds — desired, since the value text may have
        // sharpened over time.
        putMemory("facts", f.key, f.value);
      } catch (persistErr) {
        // Memory write should never fail (SQLite + idempotent insert), but
        // if it does, log and continue. One bad row mustn't sink the rest.
        console.warn(`[fact-extraction] putMemory failed for "${f.key}":`, persistErr);
      }
    }
    if (facts.length > 0) {
      console.info(`[fact-extraction] graduated ${facts.length} fact(s) into memory_store`);
    }
  } catch (err) {
    console.warn("[fact-extraction] graduation pass errored (non-fatal):", err);
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
