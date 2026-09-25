import { getProvider } from "@/lib/providers";
import { summarizeTranscript, transcriptText, extractTopicSegments, type SummaryTopicSegment } from "@/lib/agents/conversation-summary";
import { unwrapWarmSummary, wrapWarmSummary } from "@/lib/agents/prepare/history-window";
import { getAgentConfig, getAgentTierProportions } from "@/lib/stores/agent-configs";
import { getDefaultModelConfig, getModelConfig, getModelParams } from "@/lib/stores/model-config";
import { putMemory } from "@/lib/stores/memory";
import {
  commitThreadWarmContext,
  getRecentMessagesWindow,
  getThread,
} from "@/lib/stores/threads";

const MAX_TOPIC_BOUNDARY_EXPANSION_TURNS = 4;
const MAX_TOPIC_PREVIEW_CHARS = 24_000;

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
export function kickBoundaryCompaction(
  threadId: string,
  boundary: string,
  options: Pick<WarmContextCompactionOptions, "autoBoundaryLockedUntilMessageCount"> = {},
): void {
  if (!threadId || !boundary) return;
  if (activeRefreshes.has(threadId) || pendingBoundaries.has(threadId)) return;
  const basePin = getThread(threadId)?.hot_since ?? null;
  pendingBoundaries.set(threadId, boundary);
  activeRefreshes.add(threadId);
  queueMicrotask(() => {
    void commitBoundaryCompaction(threadId, boundary, basePin, options)
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
  options: Pick<WarmContextCompactionOptions, "autoBoundaryLockedUntilMessageCount">,
): Promise<void> {
  const committed = await compactThreadWarmContext(threadId, boundary, {
    expectedHotSince: basePin,
    alignTopicBoundary: true,
    allowEmptySummary: true,
    ...options,
  });
  if (!committed) return;
  console.info(
    `[context-boundary:auto] thread=${threadId} committed boundary=${committed.boundary} warm_msgs=${committed.sourceMessages}`,
  );
}

export async function findTopicBoundary(threadId: string, boundary: string): Promise<string | null> {
  const thread = getThread(threadId);
  if (!thread) return null;
  const agent = getAgentConfig(thread.agent_id);
  if (!agent) return null;
  const modelName = agent.model_config_name ?? getDefaultModelConfig()?.name ?? null;
  const modelCfg = modelName ? getModelConfig(modelName) : null;
  if (!modelCfg?.provider || !modelCfg.model_id) return null;

  const rows = getRecentMessagesWindow(threadId, 0, undefined, "foreground")
    .filter((row) => row.role === "user" || row.role === "assistant");
  const boundaryIndex = rows.findIndex((row) => row.created_at >= boundary);
  if (boundaryIndex < 0) return null;

  const previewRows = rows.slice(Math.max(0, boundaryIndex - 8), Math.min(rows.length, boundaryIndex + 10));
  let previewChars = 0;
  const previewParts: string[] = [];
  for (const row of previewRows) {
    if (previewChars >= MAX_TOPIC_PREVIEW_CHARS) break;
    const prefix = `[${row.created_at}] ${row.role === "user" ? "User" : "Assistant"}: `;
    const remaining = MAX_TOPIC_PREVIEW_CHARS - previewChars - prefix.length;
    if (remaining <= 0) break;
    const text = transcriptText(row.content).slice(0, remaining);
    previewParts.push(`${prefix}${text}`);
    previewChars += prefix.length + text.length;
  }
  const transcript = previewParts.join("\n\n").trim();
  if (!transcript) return null;

  try {
    const provider = getProvider(modelCfg.provider);
    const params = getModelParams(modelCfg);
    const raw = await summarizeTranscript(provider, modelCfg.model_id, {
      ...params,
      max_tokens: params.max_tokens ?? 768,
    }, transcript);
    const { topics } = extractTopicSegments(raw);
    const candidate = topics
      .filter((topic) => topic.start_at < boundary && topic.end_at >= boundary)
      .sort((a, b) => b.start_at.localeCompare(a.start_at))[0];
    if (!candidate) return null;

    const candidateIndex = rows.findIndex((row) => row.created_at >= candidate.start_at);
    if (candidateIndex < 0 || candidateIndex >= boundaryIndex) return null;
    const expansionTurns = rows.slice(candidateIndex, boundaryIndex).filter((row) => row.role === "user").length;
    return expansionTurns <= MAX_TOPIC_BOUNDARY_EXPANSION_TURNS ? candidate.start_at : null;
  } catch {
    return null;
  }
}

export async function refreshWarmSummary(threadId: string): Promise<void> {
  const thread = getThread(threadId);
  if (!thread?.hot_since) return;
  await compactThreadWarmContext(threadId, thread.hot_since, {
    expectedHotSince: thread.hot_since,
    alignTopicBoundary: false,
    allowEmptySummary: true,
  });
}

interface BuiltSummary {
  /** Wrapped recap text, or "" when there was too little to summarise. */
  summary: string;
  sourceMessages: number;
  sourceChars: number;
  // Per-topic segmentation of the same range (see SummaryTopicSegment). Empty
  // when the summarizer didn't return a `jarela-topics` fence.
  topics: SummaryTopicSegment[];
}

export interface CommittedWarmContext {
  boundary: string;
  summary: string;
  sourceMessages: number;
  sourceChars: number;
  topics: SummaryTopicSegment[];
}

export interface WarmContextCompactionOptions {
  expectedHotSince?: string | null;
  expectedWarmSummary?: string | null;
  alignTopicBoundary?: boolean;
  allowEmptySummary?: boolean;
  autoBoundaryLockedUntilMessageCount?: number;
}

// The only path that turns raw foreground history into warm context. The LLM
// call happens before the conditional transaction; `commitThreadWarmContext`
// then publishes the matching recap and hot boundary together or rejects a
// stale result if another action changed the pin meanwhile.
export async function compactThreadWarmContext(
  threadId: string,
  requestedBoundary: string,
  options: WarmContextCompactionOptions = {},
): Promise<CommittedWarmContext | null> {
  const baseThread = getThread(threadId);
  if (!baseThread) return null;
  const topicBoundary = options.alignTopicBoundary ? await findTopicBoundary(threadId, requestedBoundary) : null;
  const boundary = topicBoundary ?? requestedBoundary;
  const built = await buildSummaryBefore(threadId, boundary);
  if (!built || (!built.summary && !options.allowEmptySummary)) return null;

  const committed = commitThreadWarmContext(threadId, {
    hotSince: boundary,
    summary: built.summary ? wrapWarmSummary(built.summary, "foreground") : "",
    sourceMessages: built.sourceMessages,
    sourceChars: built.sourceChars,
    topics: built.topics.length > 0 ? JSON.stringify(built.topics) : null,
    expectedHotSince: Object.hasOwn(options, "expectedHotSince") ? options.expectedHotSince : (baseThread.hot_since ?? null),
    expectedWarmSummary: Object.hasOwn(options, "expectedWarmSummary")
      ? options.expectedWarmSummary
      : (baseThread.warm_summary ?? null),
    autoBoundaryLockedUntilMessageCount: options.autoBoundaryLockedUntilMessageCount,
  });
  if (!committed) return null;
  upliftTopicFacts(built.topics);
  return { boundary, ...built };
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
  const prior = thread.warm_summary ? unwrapWarmSummary(thread.warm_summary) : null;
  const canExtendPrior = prior?.scope === "foreground"
    && !!thread.warm_summary_before
    && thread.warm_summary_before < boundary;
  const warmRows = rows.filter((m) => m.created_at < boundary && (!canExtendPrior || m.created_at >= thread.warm_summary_before!));
  const newChars = warmRows.reduce((acc, row) => acc + transcriptText(row.content).length, 0);
  const sourceMessages = canExtendPrior
    ? (thread.warm_summary_source_messages ?? 0) + warmRows.length
    : warmRows.length;
  const sourceChars = canExtendPrior
    ? (thread.warm_summary_source_chars ?? 0) + newChars
    : newChars;

  if ((canExtendPrior ? newChars : sourceChars) < 24 || (canExtendPrior ? warmRows.length === 0 : warmRows.length < 2)) {
    return { summary: canExtendPrior ? prior.content : "", sourceMessages, sourceChars, topics: [] };
  }

  const contextTokens = typeof providerParams.context_window_tokens === "number"
    ? providerParams.context_window_tokens
    : 32768;
  const summaryInputChars = Math.max(4000, Math.min(120000, Math.round(contextTokens * 3)));

  const newTranscript = warmRows
    .map((m) => `[${m.created_at}] ${m.role === "user" ? "User" : "Assistant"}: ${transcriptText(m.content)}`)
    .join("\n\n")
    .trim();
  const transcript = (canExtendPrior
    ? [
        "Previous compressed memory (preserve every fact, identifier, and decision below):",
        prior.content,
        "",
        "--- New turns since the above summary ---",
        newTranscript,
      ].join("\n\n")
    : newTranscript
  ).slice(-summaryInputChars).trim();
  if (!transcript) return null;

  const provider = getProvider(modelCfg.provider);
  const summaryParams = providerParams.max_tokens
    ? providerParams
    : { ...providerParams, max_tokens: 1024 };

  const raw = (await summarizeTranscript(provider, modelCfg.model_id, summaryParams, transcript)).trim();
  if (!raw) return null;
  const { body: summary, topics } = extractTopicSegments(raw);
  if (!summary) return null;

  return {
    summary: [
      "--- Warm context summary ---",
      "Compressed recap of earlier messages outside the hot window:",
      summary,
    ].join("\n"),
    sourceMessages: warmRows.length,
    sourceChars,
    topics,
  };
}

// Batched uplift (once per compaction pass, covering every topic segment
// together — not fired per-segment as each is identified). Direct writes,
// same as the agent-facing memory_upsert tool: background compaction has
// no tool-call loop to route an approval through, and facts already write
// without a gate today. Exported so lib/agents/thread-compaction.ts (the
// manual /compact path, which also produces topic segments) can reuse it.
export function upliftTopicFacts(topics: readonly SummaryTopicSegment[]): void {
  const seenKeys = new Set<string>();
  for (const topic of topics) {
    for (const fact of topic.facts) {
      const key = slugifyForMemoryKey(fact.subject);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      putMemory("facts", key, {
        version: 2,
        kind: "fact",
        subject: fact.subject,
        content: fact.content,
        tags: fact.tags,
        confidence: fact.confidence,
        source: "conversation",
        observed_at: null,
        expires_at: null,
        summary: null,
        aliases: [],
        status: "active",
      });
    }
  }
}

function slugifyForMemoryKey(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
