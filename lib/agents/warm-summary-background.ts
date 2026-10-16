import { getProvider } from "@/lib/providers";
import type { ModelProvider, ProviderParams } from "@/lib/providers/types";
import { summarizeTranscript, transcriptText, extractTopicSegments, validateTopicSegments, parseStoredTopics, type SummaryTopicSegment } from "@/lib/agents/conversation-summary";
import { canMergeIntoTopics, finalizeFreshTopics, mergeWarmTopics, renderTopicRecaps, slugifyForMemoryKey } from "@/lib/agents/warm-topics";
import { formatTranscriptRow, runCompactionPipeline, type CompactionSource, type PipelineSourceRow } from "@/lib/agents/compaction-pipeline";
import { takeRecentWarmMessages, warmSummaryMessageLimit, wrapWarmSummary, AUTOMATION_CHANNEL_ORDER } from "@/lib/agents/prepare/history-window";
import { getAgentConfig, getAgentTierProportions } from "@/lib/stores/agent-configs";
import { getModelParams, resolveRunnableModelConfig } from "@/lib/stores/model-config";
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
  return queuedBoundaries.get(threadId)?.boundarySeq
    ?? pendingBoundaries.get(threadId)
    ?? manualBoundaries.get(threadId)
    ?? null;
}

// Manual /compact runs outside the auto-compaction queue; track it so a
// client that reloads the thread mid-compaction still sees it pending.
const manualBoundaries = new Map<string, number>();

export async function trackManualCompaction<T>(
  threadId: string,
  boundarySeq: number,
  run: () => Promise<T>,
): Promise<T> {
  manualBoundaries.set(threadId, boundarySeq);
  try {
    return await run();
  } finally {
    if (manualBoundaries.get(threadId) === boundarySeq) manualBoundaries.delete(threadId);
  }
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
  const modelCfg = resolveRunnableModelConfig(agent.model_config_name);
  if (!modelCfg?.provider || !modelCfg.model_id) return null;

  const rows = getRecentMessagesWindow(threadId, 0, undefined, "foreground")
    .filter((row) => row.role === "user" || row.role === "assistant");
  const boundaryIndex = rows.findIndex((row) => row.seq >= boundarySeq);
  if (boundaryIndex < 0) return null;
  if (boundaryIndex === 0) {
    return { created_at: rows[0].created_at, seq: rows[0].seq };
  }

  const hotTurnLimit = Math.max(1, agent.hot_turn_limit ?? 12);
  const topicLookbackMessages = Math.max(8, warmSummaryMessageLimit(agent.warm_summary_limit) + hotTurnLimit * 2);
  const topicLookaheadMessages = Math.max(10, hotTurnLimit * 2);
  const previewRows = rows.slice(
    Math.max(0, boundaryIndex - topicLookbackMessages),
    Math.min(rows.length, boundaryIndex + topicLookaheadMessages),
  );
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
    const candidate = validateTopicSegments(topics, rows, previewRows, {
      boundarySeq,
      crossesBoundary: true,
    })
      .sort((a, b) => (b.start_seq ?? 0) - (a.start_seq ?? 0))[0];
    if (!candidate) return null;

    const candidateIndex = rows.findIndex((row) => row.seq === candidate.start_seq);
    if (candidateIndex < 0 || candidateIndex >= boundaryIndex) return null;
    return { created_at: rows[candidateIndex].created_at, seq: rows[candidateIndex].seq };
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
  // Topics produced by this pass only; their extracted facts get uplifted.
  // Stored topics merged in earlier were uplifted when they were fresh.
  freshTopics: SummaryTopicSegment[];
}

export interface CommittedWarmContext {
  boundary: string;
  boundarySeq: number;
  summary: string;
  sourceMessages: number;
  sourceChars: number;
  topics: SummaryTopicSegment[];
  /** Per automation channel (ADR-0044), committed at the same boundary. */
  channels: Array<{ channel: string; summary: string; sourceMessages: number }>;
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
  if (options.alignTopicBoundary && !topicBoundary) return null;
  if (
    topicBoundary
    && baseThread.hot_since_seq === topicBoundary.seq
    && baseThread.warm_summary_before_seq === topicBoundary.seq
  ) return null;
  const boundarySeq = topicBoundary?.seq ?? requestedBoundarySeq;
  const boundaryRow = getThreadMessageBySeq(threadId, boundarySeq)
    ?? getThreadMessageBySeq(threadId, boundarySeq - 1);
  if (!boundaryRow) return null;
  const boundary = boundaryRow.created_at;
  const built = await buildSummaryBefore(threadId, boundary, boundarySeq, options.providerOverride);
  if (!built) return null;

  const channelSummaries = await Promise.all(AUTOMATION_CHANNEL_ORDER.map(async (channel) => {
    const channelSummary = await buildAutomationChannelSummaryBefore(threadId, channel, boundarySeq, options.providerOverride);
    if (!channelSummary) throw new Error(`Could not build ${channel} warm summary`);
    return {
      channel,
      summary: channelSummary.summary,
      sourceMessages: channelSummary.sourceMessages,
      topics: channelSummary.topics ? JSON.stringify(channelSummary.topics) : null,
    };
  }));
  // A thread whose only activity is automation (e.g. a bridge-only agent) has
  // an empty chat summary but real channel recaps — that is still a result.
  const anySummary = !!built.summary || channelSummaries.some((c) => !!c.summary);
  if (!anySummary && !options.allowEmptySummary) return null;

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
    channelSummaries: channelSummaries.map(({ channel, summary, topics }) => ({ channel, summary, topics })),
  });
  if (!committed) return null;
  upliftTopicFacts(built.freshTopics);
  const { freshTopics: _fresh, ...context } = built;
  const channels = channelSummaries.map(({ channel, summary, sourceMessages }) => ({ channel, summary, sourceMessages }));
  return { boundary, boundarySeq, ...context, channels };
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

  const modelCfg = resolveRunnableModelConfig(agent.model_config_name);
  if (!modelCfg?.provider || !modelCfg.model_id) return null;

  const baseParams = providerOverride?.params ?? getModelParams(modelCfg);
  const tier = getAgentTierProportions(agent);
  const providerParams = tier ? { ...baseParams, context_tier_proportions: tier } : baseParams;

  const rows = getRecentMessagesWindow(threadId, 0, undefined, "foreground")
    .filter((m) => m.role === "user" || m.role === "assistant");
  const contextTokens = typeof providerParams.context_window_tokens === "number"
    ? providerParams.context_window_tokens
    : 32768;
  const summaryInputChars = Math.max(4000, Math.min(120000, Math.round(contextTokens * 3)));
  const provider = providerOverride?.provider ?? getProvider(modelCfg.provider);
  const modelId = providerOverride?.modelId ?? modelCfg.model_id;
  const summaryParams = providerParams.max_tokens
    ? providerParams
    : { ...providerParams, max_tokens: 1024 };

  const outcome = await runTopicCompaction({
    threadId,
    source: "chat",
    rows,
    storedTopics: parseStoredTopics(thread.warm_summary_topics),
    storedBeforeSeq: thread.warm_summary_before_seq,
    boundarySeq,
    warmSummaryLimit: agent.warm_summary_limit,
    summaryInputChars,
    provider,
    modelId,
    params: summaryParams,
  });
  if (outcome.status === "empty") {
    return { summary: "", sourceMessages: outcome.sourceMessages, sourceChars: outcome.sourceChars, topics: [], freshTopics: [] };
  }
  if (outcome.status === "topics") {
    return {
      summary: wrapTopicSummary(outcome.topics),
      sourceMessages: outcome.sourceMessages,
      sourceChars: outcome.sourceChars,
      topics: outcome.topics,
      freshTopics: outcome.freshTopics,
    };
  }
  console.warn(`[warm-summary] thread=${threadId} compaction pipeline failed validation; using single-call summary`);

  const eligibleRows = takeRecentWarmMessages(rows.filter((m) => m.seq < boundarySeq), agent.warm_summary_limit);
  const { selectedRows, transcript } = selectTranscriptRows(eligibleRows, summaryInputChars);
  const selectedSourceChars = selectedRows.reduce((total, row) => total + transcriptText(row.content).length, 0);
  if (selectedSourceChars < 24 || selectedRows.length < 2) {
    return { summary: "", sourceMessages: selectedRows.length, sourceChars: selectedSourceChars, topics: [], freshTopics: [] };
  }

  if (!transcript) return null;

  const raw = (await summarizeTranscript(provider, modelId, summaryParams, transcript)).trim();
  if (!raw) return null;
  const { body, topics } = extractTopicSegments(raw);
  const validatedTopics = finalizeFreshTopics(validateTopicSegments(topics, rows, selectedRows, {
    boundarySeq,
    allowPartialStart: true,
  }), selectedRows);
  const summarizedSeqs = new Set(validatedTopics.flatMap((topic) =>
    selectedRows
      .filter((row) => row.seq >= topic.start_seq! && row.seq <= topic.end_seq!)
      .map((row) => row.seq),
  ));
  const summarizedRows = validatedTopics.length > 0
    ? selectedRows.filter((row) => summarizedSeqs.has(row.seq))
    : selectedRows;
  if (validatedTopics.length === 0 && !body) return null;
  const sourceMessages = summarizedRows.length;
  const sourceChars = summarizedRows.reduce((total, row) => total + transcriptText(row.content).length, 0);

  return {
    summary: validatedTopics.length > 0 ? wrapTopicSummary(validatedTopics) : wrapTopicSummary(null, body),
    sourceMessages,
    sourceChars,
    topics: validatedTopics,
    freshTopics: validatedTopics,
  };
}

type TopicCompactionOutcome =
  | { status: "empty"; sourceMessages: number; sourceChars: number }
  | { status: "topics"; topics: SummaryTopicSegment[]; freshTopics: SummaryTopicSegment[]; sourceMessages: number; sourceChars: number }
  | { status: "failed" };

interface TopicCompactionInput<T extends PipelineSourceRow> {
  threadId: string;
  source: CompactionSource;
  /** Every row of this message stream, ascending by seq. */
  rows: readonly T[];
  storedTopics: SummaryTopicSegment[] | null;
  storedBeforeSeq: number | null | undefined;
  boundarySeq: number;
  warmSummaryLimit: number | null | undefined;
  summaryInputChars: number;
  provider: Pick<ModelProvider, "chat">;
  modelId: string;
  params: ProviderParams;
}

/**
 * Shared by chat and every automation channel: run the compaction pipeline
 * (lib/agents/compaction-pipeline.ts) over one message stream. Incremental
 * when the stored topics can be extended — only rows that aged out of hot
 * since the last pass are folded in; otherwise the recent warm window is
 * regrouped from scratch. "failed" tells the caller to use its single-call
 * fallback.
 */
async function runTopicCompaction<T extends PipelineSourceRow>(input: TopicCompactionInput<T>): Promise<TopicCompactionOutcome> {
  const { threadId, source, rows, storedTopics, storedBeforeSeq, boundarySeq } = input;
  const messageLimit = warmSummaryMessageLimit(input.warmSummaryLimit);
  const incremental = messageLimit > 0 && canMergeIntoTopics(storedTopics, storedBeforeSeq, boundarySeq);
  const priorTopics = incremental ? storedTopics! : [];
  const candidates = incremental
    ? rows.filter((m) => m.seq >= storedBeforeSeq! && m.seq < boundarySeq)
    : takeRecentWarmMessages(rows.filter((m) => m.seq < boundarySeq), input.warmSummaryLimit);
  const { selectedRows } = selectTranscriptRows(candidates, input.summaryInputChars);
  if (incremental && selectedRows.length === 0) {
    const kept = mergeWarmTopics(priorTopics, [], messageLimit);
    return { status: "topics", topics: kept.topics, freshTopics: [], sourceMessages: kept.sourceMessages, sourceChars: kept.sourceChars };
  }
  const selectedChars = selectedRows.reduce((total, row) => total + transcriptText(row.content).length, 0);
  if (!incremental && (selectedChars < 24 || selectedRows.length < 2)) {
    return { status: "empty", sourceMessages: selectedRows.length, sourceChars: selectedChars };
  }
  const firstSeq = selectedRows[0]?.seq ?? boundarySeq;
  const label = `[warm-summary] thread=${threadId} source=${source} ${incremental ? "merge" : "rebuild"}`;
  const pipeline = await runCompactionPipeline({
    provider: input.provider,
    modelId: input.modelId,
    params: input.params,
    rows: selectedRows,
    priorTopics,
    messageLimit: messageLimit > 0 ? messageLimit : selectedRows.length,
    partialStart: !incremental && rows.some((m) => m.seq < firstSeq),
    source,
    log: (message) => console.info(`${label} ${message}`),
  }).catch((err: unknown) => {
    console.warn(`${label} compaction pipeline threw:`, err);
    return null;
  });
  if (!pipeline) return { status: "failed" };
  return {
    status: "topics",
    topics: pipeline.topics,
    freshTopics: pipeline.freshTopics,
    sourceMessages: pipeline.sourceMessages,
    sourceChars: pipeline.sourceChars,
  };
}

function selectTranscriptRows<T extends { seq: number; created_at: string; role: string; content: string }>(
  rows: readonly T[],
  budgetChars: number,
): { selectedRows: T[]; transcript: string } {
  // Newest first, so a budget overflow drops the oldest messages.
  const selectedRows: T[] = [];
  const parts: string[] = [];
  let chars = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const formatted = formatTranscriptRow(row);
    const added = formatted.length + (parts.length > 0 ? 2 : 0);
    if (chars + added > budgetChars) break;
    selectedRows.unshift(row);
    parts.unshift(formatted);
    chars += added;
  }
  return { selectedRows, transcript: parts.join("\n\n").trim() };
}

function wrapTopicSummary(topics: readonly SummaryTopicSegment[] | null, body = ""): string {
  return [
    "--- Warm context summary ---",
    "Compressed recap of recent messages immediately before the hot window:",
    topics ? renderTopicRecaps(topics) : body,
  ].join("\n");
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
      // The agent already saved this one during the turn; don't overwrite it.
      if (fact.origin === "agent") continue;
      const key = fact.key?.startsWith("facts/") ? fact.key.slice("facts/".length) : slugifyForMemoryKey(fact.subject);
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

export interface BuiltChannelSummary {
  /** "" when there was too little automation activity to summarise. */
  summary: string;
  sourceMessages: number;
  sourceChars: number;
  /** Stored topics when the compaction pipeline produced them; null for the single-call fallback. */
  topics: SummaryTopicSegment[] | null;
}

const AUTOMATION_COMPACTION_SOURCES: readonly CompactionSource[] = ["scheduled_task", "watcher", "bridge"];

function automationCompactionSource(channel: string): CompactionSource {
  return (AUTOMATION_COMPACTION_SOURCES as readonly string[]).includes(channel) ? channel as CompactionSource : "scheduled_task";
}

// ADR-0044 channels never uplift facts to memory, so the only facts a channel
// topic keeps are memory the agent itself saved there (verified in code).
function keepSavedFactsOnly(topics: readonly SummaryTopicSegment[]): SummaryTopicSegment[] {
  return topics.map((topic) => ({ ...topic, facts: topic.facts.filter((fact) => fact.origin === "agent") }));
}

function wrapChannelSummary(channel: string, body: string): string {
  return [
    `--- ${channel} activity summary ---`,
    "Compressed recap of automation activity outside the hot window:",
    body,
  ].join("\n");
}

// ADR-0044 — the automation-channel counterpart to buildSummaryBefore. Chat
// keeps using buildSummaryBefore/compactThreadWarmContext (the legacy
// threads.warm_summary* columns ARE the "chat" channel's summary, per the
// ADR's fallback design); this covers scheduled_task/watcher/bridge, each
// cached in its own thread_channel_summaries row.
//
// Same compaction pipeline as chat (group -> recap -> merge, incremental into
// the channel's stored topics), with source-specific prompt wording. Unlike
// chat there is no topic-fact uplift: automation logs rarely carry durable
// personal facts, so channel topics only keep memory the agent saved itself.
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

  const modelCfg = resolveRunnableModelConfig(agent.model_config_name);
  if (!modelCfg?.provider || !modelCfg.model_id) return null;

  const baseParams = providerOverride?.params ?? getModelParams(modelCfg);
  const tier = getAgentTierProportions(agent);
  const providerParams = tier ? { ...baseParams, context_tier_proportions: tier } : baseParams;

  const rows = getMessagesByAutomationCategory(threadId, channel);
  const contextTokens = typeof providerParams.context_window_tokens === "number"
    ? providerParams.context_window_tokens
    : 32768;
  const summaryInputChars = Math.max(4000, Math.min(120000, Math.round(contextTokens * 3)));
  const provider = providerOverride?.provider ?? getProvider(modelCfg.provider);
  const modelId = providerOverride?.modelId ?? modelCfg.model_id;
  const summaryParams = providerParams.max_tokens
    ? providerParams
    : { ...providerParams, max_tokens: 1024 };

  const stored = getThreadChannelSummary(threadId, channel);
  const outcome = await runTopicCompaction({
    threadId,
    source: automationCompactionSource(channel),
    rows,
    storedTopics: parseStoredTopics(stored?.topics ?? null),
    storedBeforeSeq: stored?.summary_before_seq,
    boundarySeq,
    warmSummaryLimit: agent.warm_summary_limit,
    summaryInputChars,
    provider,
    modelId,
    params: summaryParams,
  });
  if (outcome.status === "empty") {
    return { summary: "", sourceMessages: outcome.sourceMessages, sourceChars: outcome.sourceChars, topics: null };
  }
  if (outcome.status === "topics") {
    const topics = keepSavedFactsOnly(outcome.topics);
    return {
      summary: topics.length > 0 ? wrapChannelSummary(channel, renderTopicRecaps(topics)) : "",
      sourceMessages: outcome.sourceMessages,
      sourceChars: outcome.sourceChars,
      topics,
    };
  }
  console.warn(`[warm-summary] thread=${threadId} ${channel} compaction pipeline failed validation; using single-call summary`);

  const eligibleRows = takeRecentWarmMessages(rows.filter((m) => m.seq < boundarySeq), agent.warm_summary_limit);
  const { selectedRows, transcript } = selectTranscriptRows(eligibleRows, summaryInputChars);
  const sourceChars = selectedRows.reduce((total, row) => total + transcriptText(row.content).length, 0);
  if (sourceChars < 24 || selectedRows.length < 2) {
    return { summary: "", sourceMessages: selectedRows.length, sourceChars, topics: null };
  }
  if (!transcript) return null;

  const raw = (await summarizeTranscript(provider, modelId, summaryParams, transcript)).trim();
  if (!raw) return null;
  const { body, topics } = extractTopicSegments(raw);
  const validatedTopics = validateTopicSegments(topics, rows, selectedRows, {
    boundarySeq,
    allowPartialStart: true,
  });
  const summary = validatedTopics.length > 0
    ? renderTopicRecaps(validatedTopics.map((topic) => ({ ...topic, facts: [] })))
    : body;
  if (!summary) return null;
  const summarizedSeqs = new Set(validatedTopics.flatMap((topic) =>
    selectedRows
      .filter((row) => row.seq >= topic.start_seq! && row.seq <= topic.end_seq!)
      .map((row) => row.seq),
  ));
  const summarizedRows = validatedTopics.length > 0
    ? selectedRows.filter((row) => summarizedSeqs.has(row.seq))
    : selectedRows;
  const summarizedChars = summarizedRows.reduce((total, row) => total + transcriptText(row.content).length, 0);

  return {
    summary: wrapChannelSummary(channel, summary),
    sourceMessages: summarizedRows.length,
    sourceChars: summarizedChars,
    topics: null,
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
    topics: built.topics ? JSON.stringify(built.topics) : null,
  });
  return built;
}

// Fresh iff the cached row's summary_before matches the current boundary —
// mirrors ADR-0042's freshness check for the chat channel's warm_summary.
export function isChannelSummaryFresh(threadId: string, channel: string, boundarySeq: number): boolean {
  const cached = getThreadChannelSummary(threadId, channel);
  return !!cached && cached.summary_before_seq === boundarySeq;
}
