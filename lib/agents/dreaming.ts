import { getAgentConfig, getDefaultAgentConfig, listAgentConfigs, type AgentConfigRow } from "@/lib/stores/agent-configs";
import {
  countDreamRunsSince,
  countFailedDreamRunsSince,
  createDreamRun,
  failInterruptedDreamRuns,
  finishDreamRun,
  getDreamRun,
  getOrCreateAgentDreamState,
  listAgentDreamStates,
  listDreamRuns,
  listRunningDreamRuns,
  markDeepDream,
  markDeepDreamAttempt,
  markDreamError,
  markLightDream,
  markLightDreamAttempt,
  parseDreamRunStats,
  pruneDreamRuns,
  pruneOrphanedDreamRows,
  setAgentDreamEnabled,
  startOfLocalDay,
  sumDreamTokensSince,
  type AgentDreamRunRow,
  type AgentDreamStateRow,
  type FinishDreamRunInput,
} from "@/lib/stores/agent-dreams";
import { getDreamingSettings, setDreamingSettings } from "@/lib/stores/app-settings";
import {
  countForegroundUserMessagesAfterSeq,
  getLatestForegroundMessage,
  getLatestForegroundUserMessage,
  getRecentMessagesWindow,
  getThread,
  hasInProgressUserMessage,
  latestForegroundUserActivityAt,
  listThreadsByAgent,
  type MessageRow,
  type ThreadRow,
} from "@/lib/stores/threads";
import { getModelParams, resolveRunnableModelConfig } from "@/lib/stores/model-config";
import { getStoredMemoryValue } from "@/lib/stores/memory";
import { getProvider } from "@/lib/providers";
import { getRun, getActiveRunCount } from "@/lib/agents/run-registry";
import { getQueueDepth } from "@/lib/agents/run-queue";
import {
  compactThreadWarmContext,
  drainQueuedBoundaryAfterDream,
  pendingCompactionBoundarySeq,
} from "@/lib/agents/warm-summary-background";
import { runTrackedCompaction } from "@/lib/agents/thread-compaction-state";
import { estimateTokens } from "@/lib/agents/context-budget";
import { warmSummaryMessageLimit } from "@/lib/agents/prepare/history-window";
import { transcriptText } from "@/lib/agents/conversation-summary";
import { isMasterKeyLocked } from "@/lib/crypto/master-key";
import {
  applyMemoryMaintenance,
  auditMemory,
  memoryFingerprint,
  type MemoryAuditGroup,
  type MemoryMaintenanceOperation,
} from "@/lib/memory/maintenance";
import { MEMORY_FACTS_NAMESPACE } from "@/lib/memory/contract";
import {
  isStructuredMemoryActive,
  parseStructuredMemory,
  StructuredMemoryInputSchema,
} from "@/lib/memory/record";
import { parseJsonObject } from "@/lib/agents/compaction-pipeline";
import { reembedStaleVectors } from "@/lib/embeddings";
import {
  getDocumentIndexMaintenanceStatus,
  reclaimIndexSpace,
  rewriteLegacyDocumentEmbeddings,
  type ReclaimIndexSpaceResult,
  type RewriteEmbeddingFormatResult,
} from "@/lib/documents/lifecycle";
import { errorMessage } from "@/lib/utils/error";
import { settleWithinBudget } from "@/lib/utils/promise";
import { getOrCreateGlobal } from "@/lib/utils/global-state";
import { z } from "zod";
import type {
  DreamKind,
  DreamReadiness,
  DreamRun,
  DreamSkipReason,
  DreamingAgentStatus,
  DreamingOverview,
  DreamingRunning,
  DreamingSettings,
  DreamingSettingsPatch,
} from "@/api/dreaming";

// Agent dreaming (ADR-0135). This module owns scheduling, eligibility, and the
// two consolidation depths. It writes only dream state/journal rows and the
// existing memory/document stores; it never writes chat messages.

const LIGHT_RETRY_COOLDOWN_MS = 15 * 60_000;
const DEEP_RETRY_COOLDOWN_MS = 6 * 60 * 60_000;
const MAX_LIGHT_FAILURES_PER_IDLE_WINDOW = 2;
const MAX_LIGHT_ESTIMATED_INPUT_TOKENS = 30_000;
const ESTIMATED_OUTPUT_TOKENS = 1_024;
const WEEKLY_REVIEW_MAX_TOKENS = 800;
const MERGE_MAX_OUTPUT_TOKENS = 700;
const MERGE_CALL_TIMEOUT_MS = 45_000;
const DEEP_BUDGET_WINDOW_MS = 7 * 24 * 60 * 60_000;

const MergeDecisionSchema = z.object({
  merge: z.boolean(),
  survivor_key: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(8_000).optional(),
  tags: z.array(z.string().trim().min(1).max(48)).max(12).optional(),
  summary: z.string().trim().max(500).nullable().optional(),
  reason: z.string().trim().max(500).optional(),
}).strict();

interface DeepTokenBudget {
  /** 0 = no ceiling. */
  limit: number;
  /** Estimated tokens already spent by deep dreams in the rolling window. */
  prior: number;
  input: number;
  output: number;
}

function budgetSpent(budget: DeepTokenBudget): number {
  return budget.prior + budget.input + budget.output;
}

function budgetAllows(budget: DeepTokenBudget, tokens: number): boolean {
  return budget.limit <= 0 || budgetSpent(budget) + tokens <= budget.limit;
}

function budgetSpend(budget: DeepTokenBudget, input: number, output: number): void {
  budget.input += Math.max(0, Math.floor(input));
  budget.output += Math.max(0, Math.floor(output));
}

interface DreamRuntime {
  /** The running dream, or null when the next sweep may start one. */
  current: Promise<void> | null;
  running: { agent_id: string; kind: DreamKind; started_at: string } | null;
}

const runtime = getOrCreateGlobal<DreamRuntime>("__jarela_dreaming", () => ({
  current: null,
  running: null,
}));

export interface LightDreamCandidate {
  agent: AgentConfigRow;
  thread: ThreadRow;
  boundarySeq: number;
  estimatedInputTokens: number;
}

interface LightEvaluation {
  readiness: DreamReadiness;
  candidate: LightDreamCandidate | null;
}

interface DeepEvaluation {
  readiness: DreamReadiness;
  agent: AgentConfigRow | null;
}

// DreamRuntime is the process-global single-flight lock. A separate lock from
// compaction state is deliberate: it spans all agents, while compaction state
// is per thread.


function skip(reason: DreamSkipReason): DreamReadiness {
  return { eligible: false, reason };
}

const ELIGIBLE: DreamReadiness = { eligible: true, reason: null };

function nowIso(now: Date): string {
  return now.toISOString();
}

/**
 * A `running` row without the process-global runtime is dead: a dream cannot
 * survive a restart, and this process is the only writer. Recover it before
 * showing status so the panel never polls a ghost run.
 */
function recoverInterruptedDreams(now: Date): void {
  if (runtime.current) return;
  failInterruptedDreamRuns(nowIso(now));
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isRetryCoolingDown(
  attemptAt: string | null,
  successAt: string | null,
  now: Date,
  cooldownMs: number,
): boolean {
  const attempt = parseIso(attemptAt);
  if (attempt === null) return false;
  const success = parseIso(successAt);
  if (success !== null && success >= attempt) return false;
  return now.getTime() - attempt < cooldownMs;
}

function isIdleFor(iso: string | null, now: Date, minutes: number): boolean {
  const at = parseIso(iso);
  if (at === null) return true;
  return now.getTime() - at >= minutes * 60_000;
}

function latestThreadForAgent(agentId: string): ThreadRow | null {
  return listThreadsByAgent(agentId, 1)[0] ?? null;
}

function agentState(agentId: string): AgentDreamStateRow {
  return getOrCreateAgentDreamState(agentId);
}

function estimateLightDreamTokens(agent: AgentConfigRow, threadId: string, boundarySeq: number): number {
  // Bound the readiness read itself: a 50-message warm limit is typical, but a
  // configured 1,000-message limit must not turn every scheduler check into a
  // full transcript read.
  const limit = Math.min(200, Math.max(20, warmSummaryMessageLimit(agent.warm_summary_limit)));
  const rows = getRecentMessagesWindow(threadId, limit, undefined, "foreground")
    .filter((row) => row.seq < boundarySeq && (row.role === "user" || row.role === "assistant"));
  const chars = rows.reduce((total, row) => total + transcriptText(row.content).length, 0);
  return Math.min(MAX_LIGHT_ESTIMATED_INPUT_TOKENS, Math.ceil(chars / 4)) + ESTIMATED_OUTPUT_TOKENS;
}

function hasRunnableModel(agent: AgentConfigRow): boolean {
  const cfg = resolveRunnableModelConfig(agent.model_config_name);
  return !!(cfg?.provider && cfg.model_id);
}

function threadBusy(threadId: string): DreamSkipReason | null {
  const run = getRun(threadId);
  if (run?.status === "running" || getQueueDepth(threadId) > 0) return "active_run";
  if (hasInProgressUserMessage(threadId)) return "queued_turn";
  if (pendingCompactionBoundarySeq(threadId) !== null) return "compaction_in_flight";
  return null;
}

function boundaryWork(
  thread: ThreadRow,
  latestUser: MessageRow,
  minUserTurns: number,
): { ok: true; boundarySeq: number } | { ok: false; reason: DreamSkipReason } {
  const boundarySeq = thread.hot_since_seq ?? null;
  if (boundarySeq !== null) {
    if (boundarySeq >= latestUser.seq) return { ok: false, reason: "too_few_turns" };
    const turns = countForegroundUserMessagesAfterSeq(thread.thread_id, boundarySeq);
    if (turns < minUserTurns) return { ok: false, reason: "too_few_turns" };
  } else {
    const turns = countForegroundUserMessagesAfterSeq(thread.thread_id, 0);
    if (turns < minUserTurns) return { ok: false, reason: "too_few_turns" };
  }
  return { ok: true, boundarySeq: latestUser.seq };
}

export function evaluateLightDream(
  agent: AgentConfigRow,
  settings: DreamingSettings,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): LightEvaluation {
  if (!settings.enabled) return { readiness: skip("disabled"), candidate: null };
  const state = agentState(agent.id);
  if (state.enabled !== 1) return { readiness: skip("agent_disabled"), candidate: null };
  const thread = latestThreadForAgent(agent.id);
  if (!thread) return { readiness: skip("no_thread"), candidate: null };
  const latest = getLatestForegroundMessage(thread.thread_id);
  if (!latest) return { readiness: skip("no_messages"), candidate: null };
  if (isMasterKeyLocked()) return { readiness: skip("locked"), candidate: null };

  const busy = threadBusy(thread.thread_id);
  if (busy) return { readiness: skip(busy), candidate: null };

  if (!options.force) {
    const [latestAny] = getRecentMessagesWindow(thread.thread_id, 1, undefined, "all");
    // Activity on a bridge/watcher/scheduled channel keeps the thread awake.
    // Falling back to foreground-only idleness could fold a live bridge
    // conversation into a summary while the user is still talking there.
    const newerChannelActivity = latestAny
      && latestAny.category != null
      && latestAny.created_at > latest.created_at;
    if (newerChannelActivity || !isIdleFor(latest.created_at, now, settings.light_idle_minutes)) {
      return { readiness: skip("not_idle"), candidate: null };
    }
  }
  if (!hasRunnableModel(agent)) return { readiness: skip("no_model"), candidate: null };
  if (warmSummaryMessageLimit(agent.warm_summary_limit) === 0) {
    return { readiness: skip("summary_disabled"), candidate: null };
  }

  const latestUser = getLatestForegroundUserMessage(thread.thread_id);
  if (!latestUser) return { readiness: skip("no_messages"), candidate: null };
  const work = boundaryWork(thread, latestUser, settings.light_min_user_turns);
  if (!work.ok) return { readiness: skip(work.reason), candidate: null };

  if (!options.force && isRetryCoolingDown(
    state.last_light_attempt_at, state.last_light_dream_at, now, LIGHT_RETRY_COOLDOWN_MS,
  )) {
    return { readiness: skip("retry_cooldown"), candidate: null };
  }
  if (!options.force
    && countFailedDreamRunsSince(agent.id, "light", latest.created_at) >= MAX_LIGHT_FAILURES_PER_IDLE_WINDOW) {
    return { readiness: skip("retry_cooldown"), candidate: null };
  }
  if (!options.force && state.last_light_dream_at && state.last_light_dream_at >= latest.created_at) {
    return { readiness: skip("already_dreamed"), candidate: null };
  }
  const dayStart = startOfLocalDay(now);
  if (!options.force && countDreamRunsSince(agent.id, "light", dayStart) >= settings.light_max_per_day) {
    return { readiness: skip("daily_limit"), candidate: null };
  }

  const estimatedInputTokens = estimateLightDreamTokens(agent, thread.thread_id, work.boundarySeq);
  if (settings.light_daily_token_budget > 0) {
    const used = sumDreamTokensSince(agent.id, "light", dayStart);
    if (used + estimatedInputTokens > settings.light_daily_token_budget) {
      return { readiness: skip("budget_exhausted"), candidate: null };
    }
  }

  return {
    readiness: ELIGIBLE,
    candidate: {
      agent,
      thread,
      boundarySeq: work.boundarySeq,
      estimatedInputTokens,
    },
  };
}

/**
 * The next local weekday/hour slot strictly after `reference`. A weekly slot
 * is a not-before time, not a guarantee: the scheduler starts it only when the
 * installation is otherwise idle.
 */
function nextWeeklySlotAfter(reference: Date, weekday: number, hour: number): Date {
  const slot = new Date(reference);
  slot.setHours(hour, 0, 0, 0);
  let offset = (weekday - slot.getDay() + 7) % 7;
  if (offset === 0 && slot.getTime() <= reference.getTime()) offset = 7;
  slot.setDate(slot.getDate() + offset);
  return slot;
}

export function isDeepDreamDue(
  state: AgentDreamStateRow,
  settings: DreamingSettings,
  now: Date = new Date(),
): boolean {
  const last = parseIso(state.last_deep_dream_at);
  // One maintenance pass per week even if a manual run landed before the slot;
  // otherwise a Sunday 02:00 manual run would make the 03:00 slot due an hour
  // later and pay for maintenance twice.
  if (last !== null && now.getTime() - last < 7 * 24 * 60 * 60_000) return false;
  const reference = last ?? parseIso(state.created_at);
  if (reference === null) return false;
  return now.getTime() >= nextWeeklySlotAfter(new Date(reference), settings.deep_weekday, settings.deep_hour).getTime();
}

function appIdleFor(now: Date, minutes: number): boolean {
  return isIdleFor(latestForegroundUserActivityAt(), now, minutes);
}

export function evaluateDeepDream(
  agent: AgentConfigRow,
  settings: DreamingSettings,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): DeepEvaluation {
  if (!settings.enabled || !settings.deep_enabled) {
    return { readiness: skip("disabled"), agent: null };
  }
  if (agent.is_default !== 1) return { readiness: skip("not_default_agent"), agent: null };
  if (isMasterKeyLocked()) return { readiness: skip("locked"), agent: null };
  if (getActiveRunCount() > 0) return { readiness: skip("active_run"), agent: null };
  if (getDocumentIndexMaintenanceStatus().running) {
    return { readiness: skip("documents_busy"), agent: null };
  }

  const state = agentState(agent.id);
  if (state.enabled !== 1) return { readiness: skip("agent_disabled"), agent: null };
  if (!options.force && !isDeepDreamDue(state, settings, now)) {
    return { readiness: skip("deep_not_due"), agent: null };
  }
  if (!options.force && !appIdleFor(now, settings.deep_idle_minutes)) {
    return { readiness: skip("not_idle"), agent: null };
  }
  if (!options.force && isRetryCoolingDown(
    state.last_deep_attempt_at, state.last_deep_dream_at, now, DEEP_RETRY_COOLDOWN_MS,
  )) {
    return { readiness: skip("retry_cooldown"), agent: null };
  }
  return { readiness: ELIGIBLE, agent };
}

export interface DreamStartResult {
  started: boolean;
  run?: DreamRun;
  reason?: DreamSkipReason;
}

function toDreamRun(row: AgentDreamRunRow): DreamRun {
  return {
    id: row.id,
    agent_id: row.agent_id,
    kind: row.kind,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    summary: row.summary,
    error: row.error,
    estimated_input_tokens: row.estimated_input_tokens,
    estimated_output_tokens: row.estimated_output_tokens,
    stats: parseDreamRunStats(row),
  };
}

interface LightOutcome extends FinishDreamRunInput {
  boundarySeq: number | null;
}

async function executeLightDream(candidate: LightDreamCandidate): Promise<LightOutcome> {
  const { agent, thread, boundarySeq } = candidate;
  const basePin = getThread(thread.thread_id)?.hot_since_seq ?? null;
  const committed = await runTrackedCompaction(
    thread.thread_id,
    "dream",
    boundarySeq,
    (attempt) => compactThreadWarmContext(thread.thread_id, boundarySeq, {
      expectedHotSinceSeq: basePin,
      alignTopicBoundary: true,
      // A light-dream candidate always has foreground chat, so an empty recap
      // is a failed summarization, not a channel-only thread. Never move the
      // boundary without a recap that actually covers the folded messages.
      allowEmptySummary: false,
      attempt,
    }),
  ).finally(() => drainQueuedBoundaryAfterDream(thread.thread_id));
  if (!committed) {
    const after = getThread(thread.thread_id);
    const settledBoundary = after?.hot_since_seq ?? null;
    const settled = !!after
      && settledBoundary !== null
      && after.warm_summary_before_seq === settledBoundary
      && after.warm_summary_computed_at !== null;
    if (settled) {
      return {
        status: "skipped",
        boundarySeq: settledBoundary,
        summary: "The context boundary already covers the conversation; nothing was left to compact.",
        stats: { reason: "no_op", boundary_seq: settledBoundary },
      };
    }
    throw new Error("The compaction produced no warm summary");
  }
  const inputTokens = Math.ceil(committed.sourceChars / 4);
  const outputTokens = Math.ceil(committed.summary.length / 4);
  return {
    status: "completed",
    boundarySeq: committed.boundarySeq,
    summary: `Compacted ${committed.sourceMessages.toLocaleString()} message${committed.sourceMessages === 1 ? "" : "s"} `
      + `into warm context (boundary seq ${committed.boundarySeq}).`,
    stats: {
      source_messages: committed.sourceMessages,
      source_chars: committed.sourceChars,
      boundary_seq: committed.boundarySeq,
      channels: committed.channels.map((channel) => ({
        channel: channel.channel,
        source_messages: channel.sourceMessages,
      })),
    },
    estimated_input_tokens: inputTokens,
    estimated_output_tokens: outputTokens,
  };
}

interface MemoryPhaseStats {
  audit: { active_records: number; archived_records: number; findings: unknown };
  applied: {
    operations: number;
    archived_records: number;
    matched: number;
    skipped: number;
    stale: number;
    failed: number;
  };
}

function runMemoryPhase(now: Date): MemoryPhaseStats {
  const audit = auditMemory({ now: nowIso(now) });
  const result = applyMemoryMaintenance({
    now: nowIso(now),
    dryRun: false,
    operations: [
      { action: "archive_expired", limit: 500 },
      { action: "archive_duplicates", limit: 500 },
    ],
  });
  const archivedRecords = result.outcomes.reduce(
    (total, outcome) => total + (outcome.affected ?? 0),
    0,
  );
  const matched = result.outcomes.reduce(
    (total, outcome) => total + (outcome.matched ?? 0),
    0,
  );
  return {
    audit: {
      active_records: audit.scan.active_records,
      archived_records: audit.scan.archived_records,
      findings: audit.findings,
    },
    applied: {
      // `result.applied` counts operations, not records. The summary and the
      // journal report records, so count `affected` from the bulk outcomes.
      operations: result.applied,
      archived_records: archivedRecords,
      matched,
      skipped: result.skipped,
      stale: result.stale,
      failed: result.failed,
    },
  };
}

interface DeepStats {
  memory?: MemoryPhaseStats;
  embedding_refresh?: string;
  document_embeddings?: RewriteEmbeddingFormatResult;
  reclaim?: ReclaimIndexSpaceResult;
  merges?: MergePhaseStats;
  skipped: string[];
  errors: string[];
  review?: { text: string; input_tokens: number; output_tokens: number };
}

async function runEmbeddingPhase(stats: DeepStats, deadline: number): Promise<void> {
  let finished = false;
  try {
    const work = reembedStaleVectors().then(() => { finished = true; });
    await settleWithinBudget(work, Math.max(1_000, deadline - Date.now()), undefined);
    stats.embedding_refresh = finished ? "completed" : "continuing_in_background";
  } catch (err) {
    stats.embedding_refresh = "failed";
    stats.errors.push(`embedding refresh: ${errorMessage(err)}`);
  }
}

async function runDocumentPhases(
  settings: DreamingSettings,
  deadline: number,
  stats: DeepStats,
): Promise<void> {
  if (getDocumentIndexMaintenanceStatus().running) {
    stats.skipped.push("document_embeddings: documents_busy");
    return;
  }
  const remainingForRewrite = Math.min(settings.deep_document_budget_ms, deadline - Date.now());
  if (remainingForRewrite < 1_000) {
    stats.skipped.push("document_embeddings: budget");
    return;
  }
  try {
    stats.document_embeddings = await rewriteLegacyDocumentEmbeddings({ budgetMs: remainingForRewrite });
  } catch (err) {
    stats.errors.push(`document embeddings: ${errorMessage(err)}`);
  }
  const remainingForReclaim = Math.min(settings.deep_reclaim_budget_ms, deadline - Date.now());
  if (remainingForReclaim < 1_000) {
    stats.skipped.push("reclaim: budget");
    return;
  }
  if (getDocumentIndexMaintenanceStatus().running) {
    stats.skipped.push("reclaim: documents_busy");
    return;
  }
  try {
    stats.reclaim = await reclaimIndexSpace({ budgetMs: remainingForReclaim });
  } catch (err) {
    // A database that has not enabled incremental auto-vacuum is an expected
    // skip, not a failed dream.
    const message = errorMessage(err);
    if (message.includes("incremental auto-vacuum")) {
      stats.skipped.push("reclaim: incremental_auto_vacuum_unavailable");
    } else {
      stats.errors.push(`reclaim: ${message}`);
    }
  }
}

type DreamModelConfig = NonNullable<ReturnType<typeof resolveRunnableModelConfig>>;
type MemoryConfidence = NonNullable<ReturnType<typeof parseStructuredMemory>>["confidence"];

function deepModelConfig(agent: AgentConfigRow, settings: DreamingSettings): DreamModelConfig | null {
  return resolveRunnableModelConfig(settings.deep_model_config_name ?? agent.model_config_name);
}

interface MergeRecord {
  namespace: string;
  key: string;
  fingerprint: string;
  record: NonNullable<ReturnType<typeof parseStructuredMemory>>;
}

interface MergeGroupOutcome {
  group_id: string;
  status: "merged" | "skipped" | "partial";
  survivor_key?: string;
  archived_keys?: string[];
  reason?: string;
  error?: string;
}

interface MergePhaseStats {
  enabled: boolean;
  considered: number;
  merged: number;
  archived_records: number;
  skipped: number;
  groups: MergeGroupOutcome[];
  errors: string[];
  estimated_tokens: number;
}

function loadMergeRecord(ref: MemoryAuditGroup["records"][number], nowMs: number): MergeRecord | null {
  const stored = getStoredMemoryValue(ref.namespace, ref.key);
  if (!stored) return null;
  if (memoryFingerprint(stored.updated_at, stored.value) !== ref.fingerprint) return null;
  const record = parseStructuredMemory(stored.value);
  if (!record || record.status !== "active" || !isStructuredMemoryActive(record, nowMs)) return null;
  return { namespace: ref.namespace, key: ref.key, fingerprint: ref.fingerprint, record };
}

function weakestConfidence(records: readonly MergeRecord[]): MemoryConfidence {
  const rank: Record<MemoryConfidence, number> = { verified: 3, explicit: 2, inferred: 1 };
  return records.reduce<MemoryConfidence>(
    (weakest, entry) => rank[entry.record.confidence] < rank[weakest] ? entry.record.confidence : weakest,
    "verified",
  );
}

function earliestObserved(records: readonly MergeRecord[]): string | null {
  return records
    .map((entry) => entry.record.observed_at)
    .filter((value): value is string => !!value)
    .sort()[0] ?? null;
}

function unionStrings(values: readonly string[], max: number): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].slice(0, max);
}

function buildMergePrompt(kind: string, subject: string, records: readonly MergeRecord[]): {
  system: string;
  user: string;
} {
  const system = [
    "You are the memory consolidation step for Jarela, a local AI assistant.",
    "Merge the supplied near-duplicate memory records into one canonical record.",
    "Return ONLY JSON, either:",
    '{"merge":true,"survivor_key":"one-of-the-supplied-keys","content":"standalone merged statement","tags":["..."],"summary":null,"reason":"..."}',
    'or {"merge":false,"reason":"..."} if the records conflict or should stay separate.',
    "Rules: the survivor key must be one of the supplied keys; kind and subject must not change;",
    "content must contain everything still true and nothing invented; use concise standalone prose;",
    "never include secrets, tokens, passwords, or personal identity details.",
    "The output is a proposal. Code validates it and may reject it.",
  ].join("\n");
  const user = JSON.stringify({
    kind,
    subject,
    records: records.map((entry) => ({
      key: entry.key,
      content: entry.record.content,
      tags: entry.record.tags,
      confidence: entry.record.confidence,
      observed_at: entry.record.observed_at,
      expires_at: entry.record.expires_at,
      summary: entry.record.summary,
    })),
  });
  return { system, user };
}

async function callMergeModel(
  cfg: DreamModelConfig,
  system: string,
  user: string,
  deadline: number,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const params = getModelParams(cfg);
  const provider = getProvider(cfg.provider);
  const signal = AbortSignal.timeout(
    Math.max(1_000, Math.min(MERGE_CALL_TIMEOUT_MS, deadline - Date.now())),
  );
  const { stream } = await provider.chat(
    cfg.model_id,
    [{ role: "system", content: system }, { role: "user", content: user }],
    {
      ...params,
      max_tokens: Math.min(params.max_tokens ?? MERGE_MAX_OUTPUT_TOKENS, MERGE_MAX_OUTPUT_TOKENS),
    },
    signal,
  );
  let text = "";
  for await (const chunk of stream) text += chunk;
  const inputTokens = estimateTokens(system) + estimateTokens(user) + 50;
  return { text: text.trim(), inputTokens, outputTokens: estimateTokens(text) };
}

async function attemptMergeGroup(
  group: MemoryAuditGroup,
  cfg: DreamModelConfig,
  now: Date,
  deadline: number,
  budget: DeepTokenBudget,
): Promise<MergeGroupOutcome> {
  if (group.truncated) {
    return { group_id: group.group_id, status: "skipped", reason: "group_truncated" };
  }
  const records = group.records
    .map((ref) => loadMergeRecord(ref, now.getTime()))
    .filter((entry): entry is MergeRecord => entry !== null);
  if (records.length < 2 || records.length !== group.records.length) {
    return { group_id: group.group_id, status: "skipped", reason: "record_changed" };
  }
  const first = records[0];
  if (!records.every((entry) => (
    entry.record.kind === first.record.kind && entry.record.subject === first.record.subject
  ))) {
    return { group_id: group.group_id, status: "skipped", reason: "kind_or_subject_mismatch" };
  }
  if (new Set(records.map((entry) => entry.record.expires_at)).size > 1) {
    return { group_id: group.group_id, status: "skipped", reason: "expiry_conflict" };
  }

  const prompt = buildMergePrompt(first.record.kind, first.record.subject, records);
  const estimatedInput = estimateTokens(prompt.system) + estimateTokens(prompt.user) + 50;
  if (!budgetAllows(budget, estimatedInput + MERGE_MAX_OUTPUT_TOKENS)) {
    return { group_id: group.group_id, status: "skipped", reason: "budget_exhausted" };
  }

  let response: Awaited<ReturnType<typeof callMergeModel>>;
  try {
    response = await callMergeModel(cfg, prompt.system, prompt.user, deadline);
  } catch (err) {
    return {
      group_id: group.group_id,
      status: "skipped",
      reason: "provider_error",
      error: errorMessage(err),
    };
  }
  budgetSpend(budget, response.inputTokens, response.outputTokens);
  if (!response.text) return { group_id: group.group_id, status: "skipped", reason: "empty_response" };

  const parsed = MergeDecisionSchema.safeParse(parseJsonObject(response.text));
  if (!parsed.success) return { group_id: group.group_id, status: "skipped", reason: "invalid_response" };
  const decision = parsed.data;
  if (!decision.merge) {
    return { group_id: group.group_id, status: "skipped", reason: "model_declined" };
  }
  const survivor = records.find((entry) => entry.key === decision.survivor_key);
  if (!survivor || !decision.content) {
    return { group_id: group.group_id, status: "skipped", reason: "invalid_survivor" };
  }

  const merged = StructuredMemoryInputSchema.safeParse({
    kind: survivor.record.kind,
    subject: survivor.record.subject,
    content: decision.content,
    tags: unionStrings([
      ...records.flatMap((entry) => entry.record.tags),
      ...(decision.tags ?? []),
    ], 12),
    confidence: weakestConfidence(records),
    source: survivor.record.source,
    observed_at: earliestObserved(records),
    expires_at: first.record.expires_at,
    summary: (decision.summary ?? survivor.record.summary)?.slice(0, 280) ?? null,
    aliases: unionStrings(records.flatMap((entry) => entry.record.aliases), 8),
    status: "active",
  });
  if (!merged.success) {
    return { group_id: group.group_id, status: "skipped", reason: "invalid_merged_record" };
  }

  const operations: MemoryMaintenanceOperation[] = [
    {
      action: "upsert",
      namespace: survivor.namespace,
      key: survivor.key,
      expected_fingerprint: survivor.fingerprint,
      record: merged.data,
    },
    ...records
      .filter((entry) => entry.key !== survivor.key)
      .map((entry): MemoryMaintenanceOperation => ({
        action: "archive",
        namespace: entry.namespace,
        key: entry.key,
        expected_fingerprint: entry.fingerprint,
      })),
  ];
  const dryRun = applyMemoryMaintenance({ now: now.toISOString(), dryRun: true, operations });
  if (dryRun.failed > 0 || dryRun.stale > 0 || dryRun.skipped > 0 || dryRun.planned !== operations.length) {
    return { group_id: group.group_id, status: "skipped", reason: "stale_or_changed" };
  }
  const applied = applyMemoryMaintenance({ now: now.toISOString(), dryRun: false, operations });
  const archivedKeys = operations
    .filter((operation) => operation.action === "archive")
    .map((operation) => operation.key);
  if (applied.failed > 0 || applied.stale > 0 || applied.skipped > 0) {
    return {
      group_id: group.group_id,
      status: "partial",
      survivor_key: survivor.key,
      archived_keys: archivedKeys,
      reason: "partial_apply",
    };
  }
  return {
    group_id: group.group_id,
    status: "merged",
    survivor_key: survivor.key,
    archived_keys: archivedKeys,
    reason: decision.reason,
  };
}

async function runMemoryMergePhase(
  agent: AgentConfigRow,
  settings: DreamingSettings,
  now: Date,
  deadline: number,
  budget: DeepTokenBudget,
): Promise<MergePhaseStats> {
  const stats: MergePhaseStats = {
    enabled: settings.deep_merge_enabled,
    considered: 0,
    merged: 0,
    archived_records: 0,
    skipped: 0,
    groups: [],
    errors: [],
    estimated_tokens: 0,
  };
  if (!settings.deep_merge_enabled) return stats;
  if (deadline - Date.now() < 2_000) {
    stats.errors.push("memory merges: budget");
    return stats;
  }

  const audit = auditMemory({
    now: now.toISOString(),
    namespace: MEMORY_FACTS_NAMESPACE,
    findings: ["near_duplicate"],
    maxGroups: Math.min(100, settings.deep_merge_max_groups * 2),
  });
  const groups = audit.groups
    .filter((group) => group.finding === "near_duplicate")
    .slice(0, settings.deep_merge_max_groups);
  stats.considered = groups.length;
  if (groups.length === 0) return stats;

  const cfg = deepModelConfig(agent, settings);
  if (!cfg?.provider || !cfg.model_id) {
    stats.errors.push("memory merges: no model");
    return stats;
  }

  const spentBefore = budget.input + budget.output;
  for (const group of groups) {
    if (Date.now() >= deadline) {
      stats.groups.push({ group_id: group.group_id, status: "skipped", reason: "budget" });
      stats.skipped += 1;
      break;
    }
    const outcome = await attemptMergeGroup(group, cfg, now, deadline, budget);
    stats.groups.push(outcome);
    if (outcome.status === "merged") {
      stats.merged += 1;
      stats.archived_records += outcome.archived_keys?.length ?? 0;
    } else {
      stats.skipped += 1;
    }
    if (outcome.error) stats.errors.push(`merge ${group.group_id}: ${outcome.error}`);
    if (outcome.reason === "budget_exhausted" || outcome.error) break;
  }
  stats.estimated_tokens = budget.input + budget.output - spentBefore;
  return stats;
}

function buildReviewDigest(stats: DeepStats): string {
  return JSON.stringify({
    memory: stats.memory ?? null,
    embedding_refresh: stats.embedding_refresh ?? "not_run",
    document_embeddings: stats.document_embeddings ?? null,
    reclaim: stats.reclaim ?? null,
    merges: stats.merges ? {
      considered: stats.merges.considered,
      merged: stats.merges.merged,
      archived_records: stats.merges.archived_records,
      skipped: stats.merges.skipped,
      error_count: stats.merges.errors.length,
    } : null,
    skipped: stats.skipped,
    error_count: stats.errors.length,
  }).slice(0, 20_000);
}

async function generateWeeklyReview(
  agent: AgentConfigRow,
  settings: DreamingSettings,
  stats: DeepStats,
  deadline: number,
  budget: DeepTokenBudget,
): Promise<DeepStats["review"] | null> {
  if (!settings.deep_review_enabled) return null;
  if (deadline - Date.now() < 2_000) return null;
  const cfg = deepModelConfig(agent, settings);
  if (!cfg?.provider || !cfg.model_id) return null;
  const digest = buildReviewDigest(stats);
  const inputTokens = estimateTokens(digest) + 250;
  if (!budgetAllows(budget, inputTokens + WEEKLY_REVIEW_MAX_TOKENS)) return null;

  try {
    const params = getModelParams(cfg);
    const provider = getProvider(cfg.provider);
    const signal = AbortSignal.timeout(Math.max(1_000, Math.min(60_000, deadline - Date.now())));
    const { stream } = await provider.chat(
      cfg.model_id,
      [
        {
          role: "system",
          content:
            "You write a short private consolidation journal for an AI assistant. "
            + "Summarize ONLY the supplied maintenance counts. Do not invent facts, give advice, "
            + "or mention anything not present in the data. This note is model-generated and is "
            + "never treated as a verified fact. Return plain text, at most 120 words.",
        },
        { role: "user", content: `Weekly consolidation results:\n${digest}` },
      ],
      { ...params, max_tokens: Math.min(params.max_tokens ?? WEEKLY_REVIEW_MAX_TOKENS, WEEKLY_REVIEW_MAX_TOKENS) },
      signal,
    );
    let text = "";
    for await (const chunk of stream) text += chunk;
    const trimmed = text.trim().slice(0, 4_000);
    if (!trimmed) return null;
    const outputTokens = estimateTokens(trimmed);
    budgetSpend(budget, inputTokens, outputTokens);
    return {
      text: trimmed,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    };
  } catch (err) {
    stats.errors.push(`weekly review: ${errorMessage(err)}`);
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function summarizeDeep(stats: DeepStats, partial: boolean): string {
  const memory = stats.memory;
  const applied = memory?.applied.archived_records ?? 0;
  const rewrite = stats.document_embeddings;
  const chunks = rewrite?.rewritten ?? 0;
  const reclaimed = stats.reclaim?.reclaimed_bytes ?? 0;
  const parts = [
    `Memory: ${applied.toLocaleString()} record${applied === 1 ? "" : "s"} archived.`,
    `Embeddings: ${chunks.toLocaleString()} legacy vector${chunks === 1 ? "" : "s"} rewritten.`,
    `Space: ${formatBytes(reclaimed)} reclaimed.`,
  ];
  const remaining = (memory?.applied.matched ?? 0) - applied;
  if (remaining > 0) parts.push(`${remaining.toLocaleString()} memory candidate(s) remain for a later pass.`);
  const memoryFailures = memory?.applied.failed ?? 0;
  if (memoryFailures > 0) parts.push(`${memoryFailures} memory operation(s) failed.`);
  if (stats.merges?.merged) {
    parts.push(
      `Merges: ${stats.merges.merged} near-duplicate group${stats.merges.merged === 1 ? "" : "s"} consolidated, `
      + `${stats.merges.archived_records} duplicate record${stats.merges.archived_records === 1 ? "" : "s"} archived.`,
    );
  }
  if (stats.merges?.errors.length) {
    parts.push(`${stats.merges.errors.length} merge error${stats.merges.errors.length === 1 ? "" : "s"}.`);
  }
  if (stats.errors.length > 0) parts.push(`${stats.errors.length} phase error${stats.errors.length === 1 ? "" : "s"}.`);
  if (partial) parts.unshift("Partial run:");
  return parts.join(" ");
}

async function executeDeepDream(
  agent: AgentConfigRow,
  settings: DreamingSettings,
  startedAt: Date,
): Promise<FinishDreamRunInput> {
  const deadline = startedAt.getTime() + settings.deep_budget_ms;
  const stats: DeepStats = { skipped: [], errors: [] };
  // One rolling-seven-day budget covers every deep model step, including the
  // merge calls and the weekly note. Prior runs are pre-charged so a manual
  // extra dream cannot reset the week's allowance.
  const budget: DeepTokenBudget = {
    limit: settings.deep_weekly_token_budget,
    prior: settings.deep_weekly_token_budget > 0
      ? sumDreamTokensSince(
        agent.id,
        "deep",
        new Date(startedAt.getTime() - DEEP_BUDGET_WINDOW_MS).toISOString(),
      )
      : 0,
    input: 0,
    output: 0,
  };

  try {
    stats.memory = runMemoryPhase(startedAt);
  } catch (err) {
    stats.errors.push(`memory: ${errorMessage(err)}`);
  }
  if (Date.now() < deadline) {
    await runEmbeddingPhase(stats, deadline);
  } else {
    stats.skipped.push("embedding refresh: budget");
  }
  if (Date.now() < deadline) {
    await runDocumentPhases(settings, deadline, stats);
  } else {
    stats.skipped.push("document maintenance: budget");
  }
  if (Date.now() < deadline) {
    stats.merges = await runMemoryMergePhase(agent, settings, startedAt, deadline, budget);
  } else {
    stats.skipped.push("memory merges: budget");
  }
  const review = Date.now() < deadline
    ? await generateWeeklyReview(agent, settings, stats, deadline, budget)
    : null;
  if (review) stats.review = review;
  const partial = Date.now() >= deadline;
  return {
    status: partial ? "partial" : "completed",
    summary: summarizeDeep(stats, partial),
    stats,
    estimated_input_tokens: budget.input,
    estimated_output_tokens: budget.output,
  };
}

function finishOutcome(runId: string, outcome: FinishDreamRunInput): void {
  const row = finishDreamRun(runId, outcome);
  if (row) {
    console.info(`[dream] ${row.kind} dream ${row.status} agent=${row.agent_id} run=${row.id}`);
  }
}

function releaseRuntime(): void {
  runtime.current = null;
  runtime.running = null;
}

function launchDream(agent: AgentConfigRow, kind: DreamKind, force: boolean): DreamStartResult {
  if (runtime.current) return { started: false, reason: "dream_running" };
  const settings = getDreamingSettings();
  const now = new Date();
  let lightCandidate: LightDreamCandidate | null = null;
  if (kind === "light") {
    const light = evaluateLightDream(agent, settings, now, { force });
    if (!light.readiness.eligible || !light.candidate) {
      return { started: false, reason: light.readiness.reason ?? "too_few_turns" };
    }
    lightCandidate = light.candidate;
  } else {
    const deep = evaluateDeepDream(agent, settings, now, { force });
    if (!deep.readiness.eligible) {
      return { started: false, reason: deep.readiness.reason ?? "deep_not_due" };
    }
  }

  const run = createDreamRun({ agent_id: agent.id, kind });
  console.info(`[dream] ${kind} dream started agent=${agent.id} run=${run.id}`);
  runtime.running = { agent_id: agent.id, kind, started_at: run.started_at };
  if (kind === "light") markLightDreamAttempt(agent.id);
  else markDeepDreamAttempt(agent.id);

  // Defer the first step: a deep dream's memory audit is synchronous SQLite
  // work. The API route and scheduler tick must get their response/tick back
  // before that scan starts.
  runtime.current = new Promise<void>((resolve) => {
    setImmediate(() => {
      void (async () => {
        try {
          if (kind === "light" && lightCandidate) {
            const outcome = await executeLightDream(lightCandidate);
            markLightDream(agent.id, outcome.boundarySeq);
            finishOutcome(run.id, outcome);
          } else {
            const outcome = await executeDeepDream(agent, settings, new Date(run.started_at));
            if (outcome.status !== "failed") markDeepDream(agent.id);
            finishOutcome(run.id, outcome);
          }
        } catch (err) {
          const message = errorMessage(err);
          markDreamError(agent.id, message);
          finishOutcome(run.id, {
            status: "failed",
            summary: "Dream failed.",
            error: message,
            // A failed light dream may already have paid for summarization.
            // Charge the preflight estimate so retries cannot bypass the daily
            // budget just by failing.
            estimated_input_tokens: kind === "light" ? lightCandidate?.estimatedInputTokens ?? 0 : 0,
          });
        } finally {
          releaseRuntime();
          resolve();
        }
      })();
    });
  });
  return { started: true, run: toDreamRun(getDreamRun(run.id)!) };
}

/**
 * Start one dream. Manual triggers may bypass the idle clock, the weekly due
 * time, and the already-dreamed/daily-run limits; they never bypass safety
 * gates or the token budget.
 */
export function startDream(
  agentId: string,
  kind: DreamKind,
  options: { force?: boolean } = {},
): DreamStartResult {
  const agent = getAgentConfig(agentId);
  if (!agent) return { started: false, reason: "agent_not_found" };
  return launchDream(agent, kind, options.force === true);
}

/**
 * Scheduler entry point. Evaluates the weekly deep dream first, then light
 * dreams in agent order. Starts at most one dream and returns immediately.
 */
export async function runDreamingSweep(now: Date = new Date()): Promise<boolean> {
  if (runtime.current) return false;
  const settings = getDreamingSettings();
  if (!settings.enabled) return false;
  try {
    recoverInterruptedDreams(now);
    pruneDreamRuns();
    pruneOrphanedDreamRows();
  } catch (err) {
    console.warn("[dream] journal maintenance failed:", errorMessage(err));
  }

  const agents = listAgentConfigs();
  const defaultAgent = getDefaultAgentConfig() ?? agents.find((agent) => agent.is_default === 1) ?? null;
  if (defaultAgent && settings.deep_enabled) {
    const deep = evaluateDeepDream(defaultAgent, settings, now);
    if (deep.readiness.eligible) return launchDream(defaultAgent, "deep", false).started;
  }
  for (const agent of agents) {
    const light = evaluateLightDream(agent, settings, now);
    if (light.readiness.eligible && light.candidate) {
      return launchDream(agent, "light", false).started;
    }
  }
  return false;
}

export function getDreamingRuntime(): DreamingRunning | null {
  if (runtime.running) return { ...runtime.running };
  const stale = listRunningDreamRuns()[0];
  return stale ? { agent_id: stale.agent_id, kind: stale.kind, started_at: stale.started_at } : null;
}

export function getDreamingOverview(now: Date = new Date()): DreamingOverview {
  try {
    recoverInterruptedDreams(now);
  } catch {
    // Status should still render if journal recovery fails.
  }
  const settings = getDreamingSettings();
  const states = new Map(listAgentDreamStates().map((state) => [state.agent_id, state]));
  const agents: DreamingAgentStatus[] = listAgentConfigs().map((agent) => {
    const state = states.get(agent.id) ?? null;
    const light = evaluateLightDream(agent, settings, now);
    const deep = evaluateDeepDream(agent, settings, now);
    return {
      agent_id: agent.id,
      name: agent.name,
      is_default: agent.is_default === 1,
      enabled: state ? state.enabled === 1 : true,
      last_light_dream_at: state?.last_light_dream_at ?? null,
      last_deep_dream_at: state?.last_deep_dream_at ?? null,
      last_light_boundary_seq: state?.last_light_boundary_seq ?? null,
      last_error: state?.last_error ?? null,
      light: light.readiness,
      deep: deep.readiness,
    };
  });
  return {
    settings,
    running: getDreamingRuntime(),
    agents,
    runs: listDreamRuns({ limit: 20 }).map(toDreamRun),
  };
}

export function updateDreamingSettings(patch: DreamingSettingsPatch): DreamingSettings {
  return setDreamingSettings(patch);
}

export function setAgentDreamingEnabled(agentId: string, enabled: boolean): void {
  setAgentDreamEnabled(agentId, enabled);
}

/** Test seam: wait for the in-flight dream and release the global lock. */
export function waitForDreaming(): Promise<void> {
  return runtime.current ?? Promise.resolve();
}

/** Test seam. */
export function __resetDreamingForTests(): void {
  runtime.current = null;
  runtime.running = null;
}
