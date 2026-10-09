import { getProvider } from "@/lib/providers";
import type { ModelProvider, ProviderParams } from "@/lib/providers/types";
import { summarizeTranscript, transcriptText, extractTopicSegments, type SummaryTopicSegment } from "@/lib/agents/conversation-summary";
import { unwrapWarmSummary, wrapWarmSummary, AUTOMATION_CHANNEL_ORDER } from "@/lib/agents/prepare/history-window";
import { getAgentConfig, getAgentTierProportions } from "@/lib/stores/agent-configs";
import { getDefaultModelConfig, getModelConfig, getModelParams } from "@/lib/stores/model-config";
import { putMemory } from "@/lib/stores/memory";
import {
  commitThreadWarmContext,
  commitThreadChannelSummary,
  getMessagesByAutomationCategory,
  getRecentMessagesWindow,
  getThread,
  getThreadMessageBySeq,
  getThreadChannelSummary,
} from "@/lib/stores/threads";

const MAX_TOPIC_BOUNDARY_EXPANSION_TURNS = 4;
const MAX_TOPIC_PREVIEW_CHARS = 24_000;

const activeRefreshes = new Set<string>();
// Boundaries an automatic compaction has proposed but not yet committed.
// The pin only moves once the recap that replaces the cut-off messages is
// stored, so the turn that proposes it still runs on the old boundary.
const pendingBoundaries = new Map<string, number>();
// A boundary request that arrived while a prior one for the same thread was
// still in flight. Last-write-wins: kickBoundaryCompaction used to silently
// drop any request that arrived while one was already running (dragging
// the divider twice quickly, or two devices moving the same thread's
// boundary — both real, supported interactions), so the thread would settle
// on whichever boundary was requested FIRST with no error and no sign the
// later request was ignored. Queuing the latest one and re-running it once
// the in-flight commit settles makes the boundary always converge on what
// the caller most recently asked for.
const queuedBoundaries = new Map<string, {
  boundarySeq: number;
  options: Pick<WarmContextCompactionOptions, "autoBoundaryLockedUntilMessageCount">;
}>();

export function kickWarmSummaryRefresh(threadId: string): void {
  if (!threadId || activeRefreshes.has(threadId)) return;
  activeRefreshes.add(threadId);
  queueMicrotask(() => {
    void refreshWarmSummary(threadId).finally(() => {
      activeRefreshes.delete(threadId);
    });
  });
}

/**
 * ISO boundary an automatic compaction is currently preparing, if any. A
 * queued (most-recently-requested) boundary takes priority over one already
 * in flight — that's what the thread will actually end up at once the
 * in-flight commit settles, so it's the honest answer to "what's pending".
 */
export function pendingCompactionBoundary(threadId: string): string | null {
  const seq = pendingCompactionBoundarySeq(threadId);
  return seq === null ? null : getThreadMessageBySeq(threadId, seq)?.created_at ?? null;
}

export function pendingCompactionBoundarySeq(threadId: string): number | null {
  return queuedBoundaries.get(threadId)?.boundarySeq ?? pendingBoundaries.get(threadId) ?? null;
}

/**
 * Prepare an automatic boundary move without applying it yet.
 *
 * Moving the pin first and summarising afterwards leaves exactly one turn
 * with no hot history AND no recap — the window query filters on the new
 * pin, so the messages the recap is supposed to cover aren't even fetched.
 * Commit both together instead: on success the pin and the recap land in
 * the same write, and on failure the thread keeps its full history.
 *
 * A request arriving while a prior one for this thread is still in flight
 * is queued (last-write-wins), not dropped — see queuedBoundaries above.
 */
export function kickBoundaryCompaction(
  threadId: string,
  boundarySeq: number,
  options: Pick<WarmContextCompactionOptions, "autoBoundaryLockedUntilMessageCount"> = {},
): void {
  if (!threadId || !Number.isSafeInteger(boundarySeq) || boundarySeq <= 0) return;
  if (activeRefreshes.has(threadId) || pendingBoundaries.has(threadId)) {
    queuedBoundaries.set(threadId, { boundarySeq, options });
    return;
  }
  runBoundaryCompaction(threadId, boundarySeq, options);
}

function runBoundaryCompaction(
  threadId: string,
  boundarySeq: number,
  options: Pick<WarmContextCompactionOptions, "autoBoundaryLockedUntilMessageCount">,
): void {
  const baseThread = getThread(threadId);
  const basePinSeq = baseThread?.hot_since_seq ?? null;
  pendingBoundaries.set(threadId, boundarySeq);
  activeRefreshes.add(threadId);
  queueMicrotask(() => {
    void commitBoundaryCompaction(threadId, boundarySeq, basePinSeq, options)
      .catch((err) => console.warn(`[context-boundary:auto] compaction failed thread=${threadId}: ${String(err)}`))
      .finally(() => {
        pendingBoundaries.delete(threadId);
        activeRefreshes.delete(threadId);
        const queued = queuedBoundaries.get(threadId);
        if (!queued) return;
        queuedBoundaries.delete(threadId);
        // Skip a no-op re-run if the boundary that just committed already
        // matches what was queued — the queued request was superseded by
        // the very commit it was waiting behind.
        const settled = getThread(threadId);
        const alreadySettled = queued.boundarySeq === (settled?.hot_since_seq ?? null);
        if (!alreadySettled) runBoundaryCompaction(threadId, queued.boundarySeq, queued.options);
      });
  });
}

async function commitBoundaryCompaction(
  threadId: string,
  boundarySeq: number,
  basePinSeq: number | null,
  options: Pick<WarmContextCompactionOptions, "autoBoundaryLockedUntilMessageCount">,
): Promise<void> {
  const committed = await compactThreadWarmContext(threadId, boundarySeq, {
    expectedHotSinceSeq: basePinSeq,
    alignTopicBoundary: true,
    allowEmptySummary: true,
    ...options,
  });
  if (!committed) return;
  console.info(
    `[context-boundary:auto] thread=${threadId} committed boundary_seq=${committed.boundarySeq} warm_msgs=${committed.sourceMessages}`,
  );
}

export interface TopicBoundary {
  created_at: string;
  // The exact row the boundary resolved to. Callers that need to act on
  // rows exactly (e.g. pruning) must use this instead of re-matching
  // `created_at` — the LLM only knows created_at labels, and several rows
  // can legitimately share one when they land in the same millisecond
  // (ADR-0088), so re-deriving a row from the string alone would silently
  // pick the wrong one of a tied group.
  seq: number;
}

export async function findTopicBoundary(threadId: string, boundarySeq: number): Promise<TopicBoundary | null> {
  const thread = getThread(threadId);
  if (!thread) return null;
  const agent = getAgentConfig(thread.agent_id);
  if (!agent) return null;
  const modelName = agent.model_config_name ?? getDefaultModelConfig()?.name ?? null;
  const modelCfg = modelName ? getModelConfig(modelName) : null;
  if (!modelCfg?.provider || !modelCfg.model_id) return null;

  const rows = getRecentMessagesWindow(threadId, 0, undefined, "foreground")
    .filter((row) => row.role === "user" || row.role === "assistant");
  const boundaryIndex = rows.findIndex((row) => row.seq >= boundarySeq);
  if (boundaryIndex < 0) return null;

  const previewRows = rows.slice(Math.max(0, boundaryIndex - 8), Math.min(rows.length, boundaryIndex + 10));
  let previewChars = 0;
  const previewParts: string[] = [];
  for (const row of previewRows) {
    if (previewChars >= MAX_TOPIC_PREVIEW_CHARS) break;
    const prefix = `[seq=${row.seq}] [${row.created_at}] ${row.role === "user" ? "User" : "Assistant"}: `;
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
      .filter((topic) => typeof topic.start_seq === "number" && typeof topic.end_seq === "number"
        && topic.start_seq < boundarySeq && topic.end_seq >= boundarySeq)
      .sort((a, b) => (b.start_seq ?? 0) - (a.start_seq ?? 0))[0];
    if (!candidate) return null;

    const candidateIndex = rows.findIndex((row) => row.seq >= candidate.start_seq!);
    if (candidateIndex < 0 || candidateIndex >= boundaryIndex) return null;
    const expansionTurns = rows.slice(candidateIndex, boundaryIndex).filter((row) => row.role === "user").length;
    return expansionTurns <= MAX_TOPIC_BOUNDARY_EXPANSION_TURNS
      ? { created_at: rows[candidateIndex].created_at, seq: rows[candidateIndex].seq }
      : null;
  } catch {
    return null;
  }
}

export async function refreshWarmSummary(threadId: string): Promise<void> {
  const thread = getThread(threadId);
  if (!thread?.hot_since_seq) return;
  await compactThreadWarmContext(threadId, thread.hot_since_seq, {
    expectedHotSinceSeq: thread.hot_since_seq,
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
  boundarySeq: number;
  summary: string;
  sourceMessages: number;
  sourceChars: number;
  topics: SummaryTopicSegment[];
}

export interface WarmContextCompactionOptions {
  expectedHotSinceSeq?: number | null;
  expectedWarmSummary?: string | null;
  alignTopicBoundary?: boolean;
  allowEmptySummary?: boolean;
  autoBoundaryLockedUntilMessageCount?: number;
  providerOverride?: {
    provider: Pick<ModelProvider, "chat">;
    modelId: string;
    params: ProviderParams;
  };
}

// The only path that turns raw foreground history into warm context. The LLM
// call happens before the conditional transaction; `commitThreadWarmContext`
// then publishes the matching recap and hot boundary together or rejects a
// stale result if another action changed the pin meanwhile.
export async function compactThreadWarmContext(
  threadId: string,
  requestedBoundarySeq: number,
  options: WarmContextCompactionOptions = {},
): Promise<CommittedWarmContext | null> {
  const baseThread = getThread(threadId);
  if (!baseThread) return null;
  const topicBoundary = options.alignTopicBoundary ? await findTopicBoundary(threadId, requestedBoundarySeq) : null;
  const boundarySeq = topicBoundary?.seq ?? requestedBoundarySeq;
  const boundaryRow = getThreadMessageBySeq(threadId, boundarySeq)
    ?? getThreadMessageBySeq(threadId, boundarySeq - 1);
  if (!boundaryRow) return null;
  const boundary = boundaryRow.created_at;
  const built = await buildSummaryBefore(threadId, boundary, boundarySeq, options.providerOverride);
  if (!built || (!built.summary && !options.allowEmptySummary)) return null;

  const channelSummaries = await Promise.all(AUTOMATION_CHANNEL_ORDER.map(async (channel) => {
    const channelSummary = await buildAutomationChannelSummaryBefore(threadId, channel, boundarySeq, options.providerOverride);
    if (!channelSummary) throw new Error(`Could not build ${channel} warm summary`);
    return { channel, summary: channelSummary.summary };
  }));

  const committed = commitThreadWarmContext(threadId, {
    hotSince: boundary,
    hotSinceSeq: boundarySeq,
    summary: built.summary ? wrapWarmSummary(built.summary, "foreground") : "",
    sourceMessages: built.sourceMessages,
    sourceChars: built.sourceChars,
    topics: built.topics.length > 0 ? JSON.stringify(built.topics) : null,
    expectedHotSinceSeq: Object.hasOwn(options, "expectedHotSinceSeq")
      ? options.expectedHotSinceSeq
      : (baseThread.hot_since_seq ?? null),
    expectedWarmSummary: Object.hasOwn(options, "expectedWarmSummary")
      ? options.expectedWarmSummary
      : (baseThread.warm_summary ?? null),
    autoBoundaryLockedUntilMessageCount: options.autoBoundaryLockedUntilMessageCount,
    channelSummaries,
  });
  if (!committed) return null;
  upliftTopicFacts(built.topics);
  return { boundary, boundarySeq, ...built };
}

/**
 * Summarise every foreground message whose seq is below `boundarySeq`. Returns null
 * when the thread/agent/model can't be resolved or the provider produced
 * nothing — callers treat that as "don't touch the stored summary".
 *
 * Both the new cut and prior-summary extension use rowid seq cursors, so
 * summary coverage and destructive pruning always select the same rows.
 */
async function buildSummaryBefore(
  threadId: string,
  boundary: string,
  boundarySeq: number,
  providerOverride?: WarmContextCompactionOptions["providerOverride"],
): Promise<BuiltSummary | null> {
  const thread = getThread(threadId);
  if (!thread) return null;

  const agent = getAgentConfig(thread.agent_id);
  if (!agent) return null;

  const modelName = agent.model_config_name ?? getDefaultModelConfig()?.name ?? null;
  const modelCfg = modelName ? getModelConfig(modelName) : null;
  if (!modelCfg?.provider || !modelCfg.model_id) return null;

  const baseParams = providerOverride?.params ?? getModelParams(modelCfg);
  const tier = getAgentTierProportions(agent);
  const providerParams = tier ? { ...baseParams, context_tier_proportions: tier } : baseParams;

  const rows = getRecentMessagesWindow(threadId, 0, undefined, "foreground")
    .filter((m) => m.role === "user" || m.role === "assistant");
  const prior = thread.warm_summary ? unwrapWarmSummary(thread.warm_summary) : null;
  const priorBoundarySeq = thread.warm_summary_before_seq ?? null;
  const canExtendPrior = prior?.scope === "foreground"
    && priorBoundarySeq !== null
    && priorBoundarySeq < boundarySeq;
  const warmRows = rows.filter((m) => {
    const belowBoundary = m.seq < boundarySeq;
    return belowBoundary && (!canExtendPrior || m.seq >= priorBoundarySeq);
  });
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
    .map((m) => `[seq=${m.seq}] [${m.created_at}] ${m.role === "user" ? "User" : "Assistant"}: ${transcriptText(m.content)}`)
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

  const provider = providerOverride?.provider ?? getProvider(modelCfg.provider);
  const modelId = providerOverride?.modelId ?? modelCfg.model_id;
  const summaryParams = providerParams.max_tokens
    ? providerParams
    : { ...providerParams, max_tokens: 1024 };

  const raw = (await summarizeTranscript(provider, modelId, summaryParams, transcript)).trim();
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

export interface BuiltChannelSummary {
  /** "" when there was too little automation activity to summarise. */
  summary: string;
  sourceMessages: number;
  sourceChars: number;
}

// ADR-0044 — the automation-channel counterpart to buildSummaryBefore. Chat
// keeps using buildSummaryBefore/compactThreadWarmContext unchanged (the
// legacy threads.warm_summary* columns ARE the "chat" channel's summary,
// per the ADR's fallback design); this covers scheduled_task/watcher/bridge,
// each cached in its own thread_channel_summaries row.
//
// Deliberately simpler than buildSummaryBefore: no extend-prior-summary
// optimisation (thread_channel_summaries has no source_messages/source_chars
// columns to carry a running count across calls) and no topic-fact uplift —
// automation activity logs are far lower volume than interactive chat and
// far less likely to carry durable personal facts worth extracting. Every
// call re-summarises the full channel history below the boundary from
// scratch; acceptable given the expected message counts.
async function buildAutomationChannelSummaryBefore(
  threadId: string,
  channel: string,
  boundarySeq: number,
  providerOverride?: WarmContextCompactionOptions["providerOverride"],
): Promise<BuiltChannelSummary | null> {
  const thread = getThread(threadId);
  if (!thread) return null;

  const agent = getAgentConfig(thread.agent_id);
  if (!agent) return null;

  const modelName = agent.model_config_name ?? getDefaultModelConfig()?.name ?? null;
  const modelCfg = modelName ? getModelConfig(modelName) : null;
  if (!modelCfg?.provider || !modelCfg.model_id) return null;

  const baseParams = providerOverride?.params ?? getModelParams(modelCfg);
  const tier = getAgentTierProportions(agent);
  const providerParams = tier ? { ...baseParams, context_tier_proportions: tier } : baseParams;

  const rows = getMessagesByAutomationCategory(threadId, channel);
  const warmRows = rows.filter((m) => m.seq < boundarySeq);
  const sourceChars = warmRows.reduce((acc, row) => acc + transcriptText(row.content).length, 0);

  if (sourceChars < 24 || warmRows.length < 2) {
    return { summary: "", sourceMessages: warmRows.length, sourceChars };
  }

  const contextTokens = typeof providerParams.context_window_tokens === "number"
    ? providerParams.context_window_tokens
    : 32768;
  const summaryInputChars = Math.max(4000, Math.min(120000, Math.round(contextTokens * 3)));

  const transcript = warmRows
    .map((m) => `[seq=${m.seq}] [${m.created_at}] ${m.role === "user" ? "User" : "Assistant"}: ${transcriptText(m.content)}`)
    .join("\n\n")
    .trim()
    .slice(-summaryInputChars);
  if (!transcript) return null;

  const provider = providerOverride?.provider ?? getProvider(modelCfg.provider);
  const modelId = providerOverride?.modelId ?? modelCfg.model_id;
  const summaryParams = providerParams.max_tokens
    ? providerParams
    : { ...providerParams, max_tokens: 1024 };

  const raw = (await summarizeTranscript(provider, modelId, summaryParams, transcript)).trim();
  if (!raw) return null;
  const { body: summary } = extractTopicSegments(raw);
  if (!summary) return null;

  return {
    summary: [
      `--- ${channel} activity summary ---`,
      "Compressed recap of automation activity outside the hot window:",
      summary,
    ].join("\n"),
    sourceMessages: warmRows.length,
    sourceChars,
  };
}

// Refresh (if stale/missing) and return the cached summary for one
// automation channel, cut at the same shared hot/warm boundary the chat
// channel uses. Returns null only when the thread/agent/model can't be
// resolved or the provider produced nothing — callers treat that as "don't
// touch the stored summary", matching compactThreadWarmContext.
export async function compactAutomationChannelWarmContext(
  threadId: string,
  channel: string,
  boundarySeq: number,
): Promise<BuiltChannelSummary | null> {
  const boundaryRow = getThreadMessageBySeq(threadId, boundarySeq)
    ?? getThreadMessageBySeq(threadId, boundarySeq - 1);
  if (!boundaryRow) return null;
  const boundary = boundaryRow.created_at;
  const built = await buildAutomationChannelSummaryBefore(threadId, channel, boundarySeq);
  if (!built) return null;
  commitThreadChannelSummary(threadId, channel, {
    summary: built.summary,
    summaryBefore: boundary,
    summaryBeforeSeq: boundarySeq,
  });
  return built;
}

// Fresh iff the cached row's summary_before matches the current boundary —
// mirrors ADR-0042's freshness check for the chat channel's warm_summary.
export function isChannelSummaryFresh(threadId: string, channel: string, boundarySeq: number): boolean {
  const cached = getThreadChannelSummary(threadId, channel);
  return !!cached && cached.summary_before_seq === boundarySeq;
}
