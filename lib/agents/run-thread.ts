import { streamWithConfig } from "@/lib/agents/llm";
import { DEFAULT_HOT_TURN_LIMIT } from "@/api/types";
import { getConfig } from "@/lib/env/config";
import { claimSystemSignals, renewSystemSignalLease, releaseSystemSignals, commitSystemSignalTranscript, type SystemSignalBatch } from "@/lib/stores/system-signals";
import { runtimeInstanceId } from "@/lib/lifecycle/system-signals";
import type { StreamChunk, StreamOptions } from "@/lib/agents/base";
import {
  createDelegationBudget,
  isDelegationBudget,
} from "@/lib/agents/delegation-budget";
import type { ContentPart } from "@/lib/tools/runtime/types";
import { spillAttachments } from "@/lib/attachments/spill";
import { fileReferenceFromContentPart, isFileReferenceMetadata, type AttachmentHandlingMetadata, type FileReferenceMetadata } from "@/lib/attachments/reference";
import { autoCompactionKeepLast, compactAgentThread } from "@/lib/agents/thread-compaction";
import { kickBoundaryCompaction, kickWarmSummaryRefresh, pendingCompactionBoundarySeq } from "@/lib/agents/warm-summary-background";
import { moveThreadContextBoundary } from "@/lib/agents/context-boundary";
import { getForegroundTabPresence } from "@/lib/api/foreground-presence";
import { addMessage, capToolEventPayload, countForegroundThreadMessages, getMessagesPage, isValidThreadContextCursor, pruneThreadMessages, getRecentlyUsedToolNames, getRecentMessagesWindow, getThread, mergeMessageMetadata, touchThread, updateMessageContent, type MessageTranscriptStatus, type PersistedToolEvent } from "@/lib/stores/threads";
import { transcriptText } from "@/lib/agents/conversation-summary";
import { getMaskRunContext } from "@/lib/redaction/context";
import { recordToolUsage } from "@/lib/stores/tool-stats";
import { getAgentConfig, getAgentTierProportions, getAgentTools, getAgentToolCredentials, parseCitationStrictness } from "@/lib/stores/agent-configs";
import { startScheduler } from "@/lib/scheduler";
import { recall, type RecalledMemory } from "@/lib/embeddings";
import { getMemoryPolicy } from "@/lib/stores/app-settings";
import { validateAssistantOutput } from "@/lib/agents/output-validator";
import { getDefaultModelConfig, getModelConfig, getModelParams, isModelConfigEnabled, listEnabledModelConfigs } from "@/lib/stores/model-config";
import { buildHistoryWindow, buildSystemPrompt, buildSurroundingsContext, buildConversationGapContext, resolveExperienceMode, warmSummaryMessageLimit, type ThreadRunRequest } from "@/lib/agents/prepare";
import { getLatestMessageUsageForThread, recordMessageUsage } from "@/lib/stores/message-usage";
import { getPricingTables, modelRatesFor, estimateProviderCostUsd } from "@/lib/stores/pricing";
import { computeContextBudget, DEFAULT_CONTEXT_WINDOW_TOKENS, estimateTokens } from "@/lib/agents/context-budget";
import {
  DEFAULT_ADAPTIVE_OUTPUT_TOKEN_CAP,
  getUsageStrategyProfile,
  resolveAdaptiveOutputTokenCap,
  resolveOutputTokenCap,
  resolveUsageStrategy,
  shouldAutoRecall,
} from "@/lib/agents/usage-strategy";
import { getKnownContextLength, getKnownMaxOutputTokens } from "@/lib/providers/known-context-windows";
import { modelThinksByDefault, thinkingReductionParams } from "@/lib/providers/capabilities";
import { routeTurnModel, type RouteDecisionMetadata } from "@/lib/agents/model-router";
import { buildCombinedManifest, classifyCitations, extractCitedMarkers, extractDeclaredReferences, mergeDeclaredReferences, type SourceManifestEntry } from "@/lib/agents/citation-checker";
import { getEffectiveProviderToolLimit } from "@/lib/providers/tool-limit";
import { withDbTransaction } from "@/lib/db/transaction";
import { allowedToolNamesFromPermissionMap, applyAgentPermissionsToCatalog, applyProviderToolLimitToCatalog, applyToolBindBudget, getAllToolCatalogAsync, getDefaultAgentToolNames, isHotLoadTool, markProxyOnlyTools, type ToolCatalogEntry } from "@/lib/tools";
import { transientRetryStream, stallRetryStream, isWriteLikeToolName, unwrapInvokedToolName, looksLikeStall } from "@/lib/agents/run-retry";
export { transientRetryDelayMs, MAX_RATE_LIMIT_RETRY_AFTER_MS, rateLimitRetryDelayMs, shouldRetryTransientError, isWriteLikeToolName, unwrapInvokedToolName, toolCallSignature, buildRetryContextSummary, buildFabricationNudge, retryTextOverlapRatio, looksLikeStall } from "@/lib/agents/run-retry";

export type { ThreadRunRequest } from "@/lib/agents/prepare";

const SELF_CONFIG_TOOLS = [
  "list_tools",
  "invoke_tool",
  "propose_config_change",
  "check_proposal",
  "read_agent_instruction",
  "read_agent_config",
  "update_agent_instruction",
  "list_harnesses",
  "read_harness",
  "list_skills",
  "read_skill",
  "write_skill",
  "workflow_progress",
  "set_env_var",
  "restart_server",
] as const;

const CONVERSATION_GAP_HINT_MS = 3 * 60 * 60 * 1000;

function withDefaultTools(tools: string[], defaults: readonly string[]): string[] {
  return Array.from(new Set([...tools, ...defaults, ...SELF_CONFIG_TOOLS]));
}

const SELF_CONFIG_TOOL_SET: ReadonlySet<string> = new Set(SELF_CONFIG_TOOLS);

// The agent may execute every name in `permitted`, but only the tools it is
// most likely to need are bound to the model: basic tools, self-config tools,
// and whatever the operator pinned on the agent. The rest stay one
// `invoke_tool` hop away, which keeps the bound set flat without making the
// agent's own configured toolset pay a round-trip.
function hotLoadToolNames(
  catalog: readonly ToolCatalogEntry[],
  permitted: readonly string[],
  pinned: readonly string[],
): string[] {
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const pinnedSet = new Set(pinned);
  return permitted.filter((name) => {
    if (SELF_CONFIG_TOOL_SET.has(name) || pinnedSet.has(name)) return true;
    const entry = byName.get(name);
    return entry ? isHotLoadTool(entry) : false;
  });
}

function isAutoBoundaryEligibleCategory(category: string | null | undefined): boolean {
  return category == null || category === "bridge";
}

function estimateRequiredHotContextTokens(
  thread_id: string,
  agentCfg: { history_limit?: number | null; history_window_hours?: number | null },
  hotSinceSeq: number | null,
  scope: "foreground" | "bridge" | "all" | "none" | undefined,
  bridgeKey: string | null | undefined,
): number | null {
  const limit = agentCfg.history_limit ?? 50;
  const windowHours = agentCfg.history_window_hours ?? 8;
  const sinceISO = hotSinceSeq === null && windowHours > 0
    ? new Date(Date.now() - windowHours * 3600_000).toISOString()
    : undefined;
  const messages = getRecentMessagesWindow(thread_id, limit, sinceISO, scope ?? "all", bridgeKey ?? undefined, undefined, hotSinceSeq ?? undefined);
  const hotTokens = messages.reduce((acc, m) => acc + estimateTokens(transcriptText(m.content)), 0);
  return hotTokens > 0 ? hotTokens : null;
}

function hotTurnBoundary(
  threadId: string,
  agentCfg: { history_limit?: number | null; history_window_hours?: number | null; hot_turn_limit?: number | null },
  scope: "foreground" | "bridge" | "all",
  bridgeKey?: string,
): number | null {
  const turnLimit = agentCfg.hot_turn_limit ?? DEFAULT_HOT_TURN_LIMIT;
  if (turnLimit <= 0 || scope === "bridge") return null;

  const thread = getThread(threadId);
  const windowHours = agentCfg.history_window_hours ?? 8;
  const sinceSeq = thread?.hot_since_seq ?? undefined;
  const sinceISO = sinceSeq === undefined && windowHours > 0
    ? new Date(Date.now() - windowHours * 3600_000).toISOString()
    : undefined;
  const messages = getRecentMessagesWindow(
    threadId,
    (agentCfg.history_limit ?? 50) > 0
      ? Math.max(agentCfg.history_limit ?? 50, turnLimit * 2)
      : agentCfg.history_limit ?? 50,
    sinceISO,
    scope,
    bridgeKey,
    undefined,
    sinceSeq,
  );
  const userMessages = messages.filter((message) => message.role === "user");
  if (userMessages.length <= turnLimit) return null;
  const boundary = userMessages[userMessages.length - turnLimit];
  return boundary?.seq ?? null;
}

// The topic-aware boundary keeps the whole active topic hot, so user turns
// since the pin usually still exceed the limit right after a commit. Without a
// cooldown every following turn re-runs the topic LLM pass only to land on the
// same pin. Skip the next half-limit turns (2 rows per turn) before re-checking.
export function hotTurnCooldownUntil(messageCount: number, hotTurnLimit: number | null | undefined): number {
  const turnLimit = hotTurnLimit ?? DEFAULT_HOT_TURN_LIMIT;
  const skipTurns = Math.max(1, Math.ceil(Math.max(1, turnLimit) / 2));
  return messageCount + skipTurns * 2 + 1;
}

async function maybeAutoCompactOversizedThread(
  agentId: string,
  threadId: string,
  onCompacting?: () => void,
  preserveNewestMessages = 0,
): Promise<void> {
  const cap = getConfig().maxThreadMessages;
  const keepLast = autoCompactionKeepLast(cap);
  const retainedMessages = keepLast + preserveNewestMessages;
  const triggerAt = cap + (cap - keepLast);
  if (!Number.isFinite(cap) || cap <= 0) return;
  // Only foreground rows are ever pruned; counting bridge/watcher/scheduled
  // rows would re-trigger an LLM compaction on every turn of a busy bridge
  // agent without ever bringing the count back under the cap.
  const messageCount = countForegroundThreadMessages(threadId);
  if (messageCount < triggerAt) return;
  try {
    // A pin that already keeps the hot tier within the retained range must not
    // be pulled back to the cutoff, nor re-summarised by an LLM on every turn.
    const pinSeq = getThread(threadId)?.hot_since_seq ?? null;
    if (pinSeq !== null && countForegroundThreadMessages(threadId, pinSeq) <= retainedMessages) {
      pruneThreadMessages(threadId, retainedMessages, pinSeq);
      return;
    }
    onCompacting?.();
    const result = await compactAgentThread(agentId, retainedMessages);
    if (result.compacted) {
      console.info(
        `[thread-compaction:auto] thread=${threadId} messages=${messageCount} keep_last=${retainedMessages} pruned=${result.pruned}`,
      );
    }
  } catch (err) {
    console.warn(`[thread-compaction:auto] thread=${threadId} failed: ${String(err)}`);
  }
}

const HOT_CONTEXT_COMPACTION_THRESHOLD = 0.85;

export function isHotContextNearBudget(usedTokens: number, hotBudgetTokens: number): boolean {
  return hotBudgetTokens > 0 && usedTokens >= hotBudgetTokens * HOT_CONTEXT_COMPACTION_THRESHOLD;
}

function conversationIdleMs(
  thread_id: string,
  scope: "foreground" | "bridge" | "all" | "none",
  bridgeKey?: string,
): number | null {
  const [latest] = getRecentMessagesWindow(thread_id, 1, undefined, scope, bridgeKey);
  const lastMs = latest ? Date.parse(latest.created_at) : NaN;
  return Number.isFinite(lastMs) ? Date.now() - lastMs : null;
}

function hasPendingQueuedUserMessage(thread_id: string): boolean {
  return getMessagesPage(thread_id, 64).messages.some(
    (message) => message.role === "user" && message.transcript_status === "in_progress",
  );
}

export class RunThreadError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface PersistedThreadRunUserMessage {
  attachments?: ContentPart[];
  idleMsBefore: number | null;
  userMessageId: string;
  storedContent: string;
}

export async function persistThreadRunUserMessage(
  req: Pick<ThreadRunRequest,
    "thread_id" | "message" | "attachments" | "user_category" | "message_metadata"
    | "history_bridge_key" | "context_profile" | "_onTranscriptUserPersisted">,
): Promise<PersistedThreadRunUserMessage> {
  const thread = getThread(req.thread_id);
  if (!thread) throw new RunThreadError(404, "Thread not found", "thread_not_found");

  const trimmed = req.message.trim();
  if (!trimmed && !req.attachments?.length) {
    throw new RunThreadError(400, "message required", "message_required");
  }

  const autoBoundaryScope = req.context_profile?.history_scope
    ?? (req.user_category === "bridge" ? "bridge" : "foreground");
  const idleMsBefore = isAutoBoundaryEligibleCategory(req.user_category)
    ? conversationIdleMs(req.thread_id, autoBoundaryScope, req.history_bridge_key ?? undefined)
    : null;
  const spilledAttachments = req.attachments?.length
    ? await spillAttachments(req.attachments)
    : undefined;
  const content: string | ContentPart[] = spilledAttachments?.length
    ? [{ type: "text", text: trimmed }, ...spilledAttachments]
    : trimmed;
  const stored = typeof content === "string" ? content : JSON.stringify(content);

  const userMessage = withDbTransaction(() => {
    const insertedUserMessage = addMessage(
      req.thread_id,
      "user",
      stored,
      undefined,
      req.user_category ?? null,
      req.message_metadata ?? null,
      "in_progress",
    );
    touchThread(req.thread_id, trimmed.slice(0, 80) || undefined);
    req._onTranscriptUserPersisted?.();
    return insertedUserMessage;
  });

  return {
    attachments: spilledAttachments,
    idleMsBefore,
    userMessageId: userMessage.msg_id,
    storedContent: stored,
  };
}

// Hard cap on how long we wait for the embedding-based recall pass before
// starting the LLM stream without it. Recall is best-effort context — making
// users wait on a cold OpenAI embeddings round-trip every turn is a worse UX
// than occasionally missing a memory hit. 400ms was too tight: warm OpenAI
// text-embedding-3-small calls land in 200–800ms, cold ones longer, so the
// race silently lost on most turns and recall effectively never fired.
function recallBudgetMs(): number {
  return getConfig().recallBudgetMs;
}

function raceWithBudget<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
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

export interface PreparedThreadRun {
  signal_delivery?: SystemSignalBatch;
  stream: AsyncIterable<StreamChunk>;
  thread_id: string;
  // Snapshot of how the per-turn context window was allocated and consumed.
  // Forwarded to `persistAssistantMessage` so message_usage carries the
  // per-tier breakdown the chat UI uses for its diagnostic context bar.
  context_snapshot?: ContextUsageSnapshot;
  // Numbered source manifest shown to the agent for this turn (when
  // `citation_strictness` is not `off`). Forwarded to `persistAssistantMessage`
  // so the EXACT list the agent saw is persisted with the message — the
  // chat UI uses it to resolve inline `[N]` markers to clickable links,
  // and the citation checker uses it to score marker validity. Empty when
  // the flag is off.
  source_manifest?: SourceManifestEntry[];
  // Per-turn model-selection decision captured before execution.
  route_decision?: RouteDecisionMetadata;
  // Counts only (never content) from the automatic recall pass this turn.
  // Forwarded to `persistAssistantMessage` for the chat UI's quiet
  // "N memories used" indicator (no per-item dump — see run history for
  // why that was tried and reverted as noise).
  memory_recall?: { memory_hits: number; message_hits: number };
}

export interface ContextUsageSnapshot {
  context_window_tokens: number;
  hot_tokens: number;
  warm_tokens: number;
  facts_tokens: number;
  overhead_tokens: number;
  hot_budget_tokens: number;
  warm_budget_tokens: number;
  facts_budget_tokens: number;
}

// JARELA_MAX_STALL_RETRIES / JARELA_MAX_TRANSIENT_RETRIES override these.
// Read fresh per turn so non-restart-required reloads take effect.
function maxStallRetries(): number { return getConfig().maxStallRetries; }
function maxTransientRetries(): number { return getConfig().maxTransientRetries; }

function getLatestRoutingObservation(threadId: string): RouteDecisionMetadata | null {
  const page = getMessagesPage(threadId, 20);
  for (let index = page.messages.length - 1; index >= 0; index -= 1) {
    const raw = page.messages[index]?.metadata;
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { routing?: RouteDecisionMetadata };
      if (parsed?.routing && typeof parsed.routing === "object") return parsed.routing;
    } catch {
      continue;
    }
  }
  return null;
}

// Hard cap on how deep an A → B → C delegation chain can go via the
// `delegate_to_agent` built-in tool. Public callers start at depth 0; the
// delegate tool increments before recursively invoking prepareThreadRun. At
// depth >= MAX_DELEGATION_DEPTH the tool refuses with `depth_exceeded` so a
// mis-configured agent network can't runaway.
export const MAX_DELEGATION_DEPTH = 2;

function contentText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is ContentPart & { type: "text" } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

function contentHasImage(content: string | ContentPart[]): boolean {
  if (typeof content !== "string") return content.some((p) => p.type === "image" || p.type === "image_ref");
  if (!content.startsWith("[")) return false;
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) && parsed.some((p) => (
      p && typeof p === "object" && "type" in p && ((p as { type?: unknown }).type === "image" || (p as { type?: unknown }).type === "image_ref")
    ));
  } catch {
    return false;
  }
}

export function snapshotThreadModelConfigName(thread_id: string): string | null {
  const thread = getThread(thread_id);
  if (!thread) return null;

  const agentCfg = getAgentConfig(thread.agent_id);
  if (!agentCfg) return null;

  if (agentCfg.model_config_name && isModelConfigEnabled(getModelConfig(agentCfg.model_config_name))) {
    return agentCfg.model_config_name;
  }
  if (getConfig().modelRouterMode !== "off") return null;
  return getDefaultModelConfig()?.name ?? null;
}

export function appendHistoryMessage(
  history: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>,
  injected: string | ContentPart[] | undefined,
): Array<{ role: "user" | "assistant"; content: string | ContentPart[] }> {
  return injected === undefined ? history : [...history, { role: "user", content: injected }];
}

/**
 * Per-turn entry point. Validates the request, persists the user message if
 * admission has not already done so, builds context, and starts the LLM stream
 * wraps the result in `stallRetryStream` so flagged turns can auto-retry.
 *
 * The 7-positional-arg version was refactored into the `ThreadRunRequest`
 * shape in ADR-0039. Internal control fields are `_`-prefixed; public
 * callers leave them undefined.
 */
export async function prepareThreadRun(req: ThreadRunRequest): Promise<PreparedThreadRun> {
  // The WeakMap-backed handle cannot be forged by request JSON. Recursive
  // retries and delegated descendants retain this same root-task budget.
  req = {
    ...req,
    _delegation_budget: isDelegationBudget(req._delegation_budget)
      ? req._delegation_budget
      : createDelegationBudget(),
  };
  const isDelegatedRun = (req._delegation_depth ?? 0) > 0
    || (req._delegation_ancestors?.length ?? 0) > 0;
  // Lazy-start the scheduler when any agent activity occurs so previously
  // saved scheduled tasks resume firing across server restarts.
  startScheduler();

  const thread = getThread(req.thread_id);
  if (!thread) throw new RunThreadError(404, "Thread not found", "thread_not_found");

  const trimmed = req.message.trim();
  if (!trimmed && !req.attachments?.length) {
    throw new RunThreadError(400, "message required", "message_required");
  }

  const agentCfg = getAgentConfig(thread.agent_id);
  if (!agentCfg) {
    throw new RunThreadError(404, `Agent "${thread.agent_id}" not found`, "agent_not_found");
  }
  const baseToolPermissionMap = applyAgentPermissionsToCatalog(await getAllToolCatalogAsync(), agentCfg);
  const requestedAllowedTools = withDefaultTools(allowedToolNamesFromPermissionMap(baseToolPermissionMap), []);
  let toolPermissionMap = baseToolPermissionMap;
  let allowedTools = requestedAllowedTools;

  if (
    !req._skip_persist_message
    && isAutoBoundaryEligibleCategory(req.user_category)
    && !hasPendingQueuedUserMessage(req.thread_id)
  ) {
    await maybeAutoCompactOversizedThread(
      agentCfg.id,
      req.thread_id,
      req._onCompacting,

      req._user_message_persisted ? 2 : 0,
    );
  }

  // Persist the user turn (including any attachments) before the LLM stream
  // so reload-mid-stream still shows the prompt. The stall-retry path sets
  // `_skip_persist_message` to keep its synthetic `↻ Auto-retry: …` nudges
  // out of the durable history — otherwise every nudge becomes a permanent
  // user-role row that the LLM mistakes for real user input on every future
  // turn.
  //
  // Spill inline `image`/`file` parts to disk before persist so
  // `messages.content` stores only lightweight refs — see ADR-0065,
  // ADR-0090, and lib/attachments/spill.ts. `toBaseMessages` reads a ref
  // back only for the newest turn or an explicit `view_attachment` call;
  // every older occurrence of the same ref collapses to a text placeholder.
  const spilledAttachments = req.attachments?.length
    ? await spillAttachments(req.attachments)
    : undefined;
  const content: string | ContentPart[] =
    spilledAttachments?.length ? [{ type: "text", text: trimmed }, ...spilledAttachments] : trimmed;
  const stored = typeof content === "string" ? content : JSON.stringify(content);

  const autoBoundaryScope = req.context_profile?.history_scope
    ?? (req.user_category === "bridge" ? "bridge" : "foreground");
  // Measured before the new user row lands, otherwise the gap is always ~0.
  const idleMsBeforeTurn = req._skip_persist_message
    ? null
    : req._idle_ms_before_user !== undefined
      ? req._idle_ms_before_user
      : isAutoBoundaryEligibleCategory(req.user_category)
        ? conversationIdleMs(req.thread_id, autoBoundaryScope, req.history_bridge_key ?? undefined)
        : null;

  if (!req._skip_persist_message) {
    if (!req._user_message_persisted) {
      withDbTransaction(() => {
        addMessage(
          req.thread_id,
          "user",
          stored,
          undefined,
          req.user_category ?? null,
          req.message_metadata ?? null,
        );
        touchThread(req.thread_id, trimmed.slice(0, 80) || undefined);
        req._onTranscriptUserPersisted?.();
      });
    }

    // Once the configured hot-turn count is exceeded, prepare a topic-aware
    // warm summary in the background. The boundary is committed only after
    // the summary succeeds, so this turn still has its previous context.
    if (
      req.hot_since_seq === undefined
      && isAutoBoundaryEligibleCategory(req.user_category)
      && autoBoundaryScope === "foreground"
      && !hasPendingQueuedUserMessage(req.thread_id)
    ) {
      const latestThread = getThread(req.thread_id);
      const locked = !!latestThread
        && latestThread.message_count < (latestThread.auto_boundary_locked_until_msg_count ?? 0);
      if (!locked) {
        const boundary = hotTurnBoundary(req.thread_id, agentCfg, autoBoundaryScope);
        if (boundary !== null) {
          kickBoundaryCompaction(req.thread_id, boundary, {
            autoBoundaryLockedUntilMessageCount: hotTurnCooldownUntil(latestThread?.message_count ?? 0, agentCfg.hot_turn_limit),
          });
        }
      }
    }
  }

  const hasImageContext = contentHasImage(content)
    || getMessagesPage(req.thread_id, agentCfg.history_limit ?? 50).messages.some((m) => contentHasImage(m.content));

  const agentTierProportions = getAgentTierProportions(agentCfg);

  const requestedHotSinceDiffers = req.hot_since_seq !== undefined
    && req.hot_since_seq !== (thread.hot_since_seq ?? null);
  if (typeof req.hot_since_seq === "number" && !isValidThreadContextCursor(req.thread_id, req.hot_since_seq)) {
    throw new RunThreadError(400, "Boundary seq does not belong to this thread", "invalid_boundary");
  }
  const effectiveHotSinceSeq = req.context_profile?.history_scope === "bridge"
    ? null
    : requestedHotSinceDiffers
      ? req.hot_since_seq === null ? null : (thread.hot_since_seq ?? null)
      : (req.hot_since_seq ?? thread.hot_since_seq ?? null);
  const requiredHotContextTokens = req.context_profile?.include_hot === false
    ? null
    : estimateRequiredHotContextTokens(
      req.thread_id,
      agentCfg,
      effectiveHotSinceSeq,
      req.context_profile?.history_scope,
      req.history_bridge_key,
    );

  // Resolve model config + provider params (for both the live stream and
  // the warm-summary recursion inside buildHistoryWindow).
  const defaultModelConfig = getDefaultModelConfig();
  let modelConfigName = req._pinned_model_config_name
    ?? agentCfg.model_config_name
    ?? null;
  // Missing or disabled configs fall through to routing / the default; a
  // disabled agent override is kept so re-enabling the model restores it.
  if (modelConfigName && !isModelConfigEnabled(getModelConfig(modelConfigName))) {
    modelConfigName = null;
  }
  let routeDecision: RouteDecisionMetadata | null = null;
  if (req._pinned_model_config_name && modelConfigName === req._pinned_model_config_name) {
    routeDecision = {
      source: "pinned",
      model_config_name: req._pinned_model_config_name,
      reason: "queued run reused the model pinned at submission time",
      retry_count: req._retry_count ?? 0,
    };
  } else if (agentCfg.model_config_name && modelConfigName === agentCfg.model_config_name) {
    routeDecision = {
      source: "agent_override",
      model_config_name: agentCfg.model_config_name,
      reason: "agent has an explicit model_config_name override",
      retry_count: req._retry_count ?? 0,
    };
  }
  // The resolved strategy is the single source of truth for model routing and usage.
  const usageStrategy = resolveUsageStrategy(agentCfg.usage_strategy, getConfig().usageStrategy);
  const usageProfile = getUsageStrategyProfile(usageStrategy);
  const autoRecallEnabled = !isDelegatedRun
    && shouldAutoRecall(usageStrategy, req.context_profile?.include_recall !== false);
  const autoFactsEnabled = shouldAutoRecall(usageStrategy, req.context_profile?.include_facts !== false);
  const useRouter = usageProfile.enableRouter ?? getConfig().modelRouterMode === "heuristic";
  const routePolicy = req._router_policy_override ?? usageProfile.routerPolicy ?? getConfig().modelRouterPolicy;
  if (!modelConfigName && useRouter) {
    const pricingTables = getPricingTables();
    const routed = routeTurnModel({
      models: listEnabledModelConfigs().map((cfg) => ({
        name: cfg.name,
        provider: cfg.provider,
        model_id: cfg.model_id,
        params: getModelParams(cfg),
        credential_id: cfg.credential_id ?? null,
        is_default: cfg.is_default === 1,
        enabled: true,
        created_at: cfg.created_at,
        updated_at: cfg.updated_at,
      })),
      message: trimmed,
      attachments: req.attachments,
      hasImageContext,
      allowedTools,
      requiredHotContextTokens,
      contextTierProportions: agentTierProportions,
      latestUsage: getLatestMessageUsageForThread(req.thread_id),
      latestObservation: getLatestRoutingObservation(req.thread_id),
      policy: routePolicy,
      rateResolver: (provider, modelId) => modelRatesFor(pricingTables, provider, modelId),
    });
    if (routed.modelConfigName) {
      modelConfigName = routed.modelConfigName;
      routeDecision = {
        source: "heuristic",
        model_config_name: routed.modelConfigName,
        route_class: routed.routeClass,
        policy: routePolicy,
        reason: routed.reason,
        candidates: routed.candidates,
        retry_count: req._retry_count ?? 0,
      };
      console.info(`[model_router] thread=${req.thread_id} class=${routed.routeClass} policy=${routePolicy} model=${routed.modelConfigName} reason=${routed.reason}`);
    }
  }
  modelConfigName = modelConfigName ?? defaultModelConfig?.name ?? null;
  if (!routeDecision) {
    routeDecision = {
      source: "default_fallback",
      model_config_name: modelConfigName,
      reason: modelConfigName
        ? "used the workspace default model because no explicit or routed model was selected"
        : "no runnable model was available",
      retry_count: req._retry_count ?? 0,
    };
  }
  const modelCfg = modelConfigName ? getModelConfig(modelConfigName) : null;
  const limitedTools = applyProviderToolLimitToCatalog(
    baseToolPermissionMap,
    applyToolBindBudget(
      hotLoadToolNames(baseToolPermissionMap, requestedAllowedTools, getAgentTools(agentCfg)),
      {
        budget: getConfig().toolBindBudget,
        alwaysKeep: [...SELF_CONFIG_TOOLS, "tool_result_get", "tool_result_list", "compact_context"],
        recentlyUsed: getRecentlyUsedToolNames(req.thread_id),
        pinned: getAgentTools(agentCfg),
      },
    ),
    getEffectiveProviderToolLimit(modelCfg?.provider),
    SELF_CONFIG_TOOLS,
    {
      candidateQuery: trimmed,
      preferredToolNames: getAgentTools(agentCfg),
    },
  );
  toolPermissionMap = markProxyOnlyTools(
    limitedTools.toolPermissionMap,
    limitedTools.allowedToolNames,
    requestedAllowedTools,
  );
  allowedTools = limitedTools.allowedToolNames;
  if (req._system_signal_continuation) {
    toolPermissionMap = toolPermissionMap.map((entry) => entry.capability === "read" || entry.name === "invoke_tool"
      ? entry
      : { ...entry, permission: "disabled" as const, permission_reason: "signal_continuation_read_only" });
    const allowedReadTools = new Set(toolPermissionMap.filter((entry) => entry.permission === "enabled").map((entry) => entry.name));
    allowedTools = allowedTools.filter((name) => allowedReadTools.has(name));
  }
  const baseProviderParams = getModelParams(modelCfg);

  // ADR-0043 — per-agent override of context_tier_proportions. The agent's
  // value, when set, replaces the model's default for THIS run only; the
  // stream LLM call below still uses the unmodified params. Splitting them
  // keeps the override scoped to the budget computation.
  const tierProviderParams = agentTierProportions
    ? { ...baseProviderParams, context_tier_proportions: agentTierProportions }
    : baseProviderParams;
  // An explicit thinking/reasoning_effort on the model config always wins over the strategy.
  const thinkingReduction = usageProfile.reduceThinking
    && modelCfg
    && baseProviderParams.thinking === undefined
    && baseProviderParams.reasoning_effort === undefined
    ? thinkingReductionParams(modelCfg.provider, modelCfg.model_id)
    : null;
  const modelThinks = baseProviderParams.thinking?.type === "enabled"
    || (!!modelCfg && modelThinksByDefault(modelCfg.provider, modelCfg.model_id)
      && !thinkingReduction?.off);
  const strategyOutputTokenCap = resolveOutputTokenCap(
    usageProfile.outputTokenCap ?? DEFAULT_ADAPTIVE_OUTPUT_TOKEN_CAP,
    modelThinks,
    usageStrategy,
  );
  // Strategy caps must apply to the model's real window, not the 8k fallback,
  // otherwise a capped strategy shrinks a 1M-token model to 8k.
  const explicitContextWindow = typeof tierProviderParams.context_window_tokens === "number"
    && tierProviderParams.context_window_tokens > 0
    ? tierProviderParams.context_window_tokens
    : null;
  const knownContextWindow = modelCfg ? getKnownContextLength(modelCfg.provider, modelCfg.model_id) : null;
  const configuredContextWindow = explicitContextWindow && knownContextWindow
    ? Math.min(explicitContextWindow, knownContextWindow)
    : explicitContextWindow ?? knownContextWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  // Attachment turns can consume substantial context, so use the model's configured window.
  const contextWindowCap = req.attachments?.length
    ? null
    : usageProfile.contextWindowCapTokens;
  const runContextWindow = contextWindowCap !== null
    ? Math.min(configuredContextWindow, contextWindowCap)
    : configuredContextWindow;
  // The current user-turn size is a deterministic proxy for expected output;
  // the adaptive resolver applies headroom and the model/context hard limits.
  const inputTokenEstimate = estimateTokens(contentText(content));
  const { overheadTokens: outputBudgetOverhead } = computeContextBudget({ context_window_tokens: runContextWindow, max_tokens: 256 });
  const contextOutputCeiling = Math.max(1, runContextWindow - inputTokenEstimate - outputBudgetOverhead);
  const explicitOutputCeiling = typeof tierProviderParams.max_tokens === "number"
    && Number.isFinite(tierProviderParams.max_tokens) && tierProviderParams.max_tokens > 0
    ? tierProviderParams.max_tokens
    : null;
  const hardOutputCeilings = [
    contextOutputCeiling,
    // The static catalog is a fallback, not an authority over explicit configuration.
    explicitOutputCeiling ?? (modelCfg ? getKnownMaxOutputTokens(modelCfg.provider, modelCfg.model_id) : null),
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  const adaptiveOutputTokenCap = resolveAdaptiveOutputTokenCap(
    inputTokenEstimate,
    strategyOutputTokenCap ?? DEFAULT_ADAPTIVE_OUTPUT_TOKEN_CAP,
    Math.min(...hardOutputCeilings),
    baseProviderParams.thinking?.budget_tokens ?? 0,
  );
  if (baseProviderParams.thinking?.type === "enabled"
    && baseProviderParams.thinking.budget_tokens >= adaptiveOutputTokenCap) {
    throw new RunThreadError(
      400,
      `The configured thinking budget (${baseProviderParams.thinking.budget_tokens}) must be lower than `
        + `the effective output-token limit (${adaptiveOutputTokenCap}). Reduce the thinking budget `
        + "or increase the model output/context limits.",
      "invalid_thinking_budget",
    );
  }
  const providerParams = {
    ...tierProviderParams,
    context_window_tokens: runContextWindow,
    max_tokens: adaptiveOutputTokenCap,
  };

  // New non-null pins are deferred until their warm summary is ready. A clear
  // broadens context, so it can be committed immediately without a recap.
  if (requestedHotSinceDiffers) {
    if (req.hot_since_seq === null) moveThreadContextBoundary(req.thread_id, null);
    else if (typeof req.hot_since_seq === "number") kickBoundaryCompaction(req.thread_id, req.hot_since_seq);
  }
  const currentThread = getThread(req.thread_id);
  if (
    !isDelegatedRun
    && currentThread?.hot_since_seq
    && currentThread.warm_summary
    && (currentThread.warm_summary_source_messages == null
      || currentThread.warm_summary_source_messages > warmSummaryMessageLimit(agentCfg.warm_summary_limit))
  ) {
    kickWarmSummaryRefresh(req.thread_id);
  }
  const historyWindow = await buildHistoryWindow(
    req.thread_id,
    agentCfg,
    providerParams,
    trimmed,
    { providerName: modelCfg?.provider, modelId: modelCfg?.model_id },
    undefined,
    {
      scope: req.context_profile?.history_scope,
      // Warm-summary generation and refresh use separate provider calls,
      // outside the delegated per-inference budget hook. Keep hot history,
      // but never start unaccounted summarization work for a child run.
      includeWarm: isDelegatedRun ? false : req.context_profile?.include_warm,
      includeFacts: autoFactsEnabled,
      bridgeKey: req.history_bridge_key ?? undefined,
      channels: req.channels,
      hotSinceSeq: effectiveHotSinceSeq,
    },
  );

  const hotBudget = historyWindow.budget.tierBudgets.hot;
  const currentHotSinceSeq = getThread(req.thread_id)?.hot_since_seq ?? null;
  if (
    !isDelegatedRun
    && autoBoundaryScope !== "bridge"
    && currentHotSinceSeq === null
    && pendingCompactionBoundarySeq(req.thread_id) === null
    && isHotContextNearBudget(historyWindow.tierUsage.hot_tokens, hotBudget)
    && historyWindow.hotSinceSeqCandidate !== null
  ) {
    kickBoundaryCompaction(req.thread_id, historyWindow.hotSinceSeqCandidate);
  }

  const { buildDelegateCatalog } = await import("@/lib/agents/delegate-catalog");
  const delegateRosterLines = await buildDelegateCatalog(agentCfg, toolPermissionMap, baseToolPermissionMap);

  // Ambient surroundings (ADR-0082). Only foreground chat turns get it: a
  // scheduled task or an extension fill firing while the user happens to be
  // on some page must not have that page steer its answer.
  const surroundingsPresence = isForegroundConversationTurn(req)
    ? getForegroundTabPresence()
    : null;
  const surroundingsCtx = buildSurroundingsContext(surroundingsPresence);
  // Recall query for the surroundings: host + title only. The URL's path is
  // noise (ids, tracking params) that drags the embedding off-topic.
  const surroundingsQuery = surroundingsPresence
    ? [surroundingsPresence.host, surroundingsPresence.title].filter(Boolean).join(" ").trim()
    : "";

  // First-response turns (no prior assistant message in the window) should
  // feel immediate; cap recall wait so we don't burn the full recall budget
  // before the model even starts streaming.
  const hasAssistantHistory = historyWindow.history.some((m) => m.role === "assistant");
  const recallWaitBudgetMs = hasAssistantHistory
    ? recallBudgetMs()
    : Math.min(recallBudgetMs(), 350);

  // Recall is best-effort: cap on the recall budget so a cold embeddings
  // round-trip doesn't block the LLM stream from starting.
  const oldestInWindow = historyWindow.history.length > 0
    ? contentText(historyWindow.history[0].content)
    : null;
  const rawRecallCtx = !autoRecallEnabled
    ? { text: "", memoryHits: 0, messageHits: 0 }
    : await raceWithBudget(
      buildRecallContext(req.thread_id, trimmed, oldestInWindow, surroundingsQuery),
      recallWaitBudgetMs,
      { text: "", memoryHits: 0, messageHits: 0 },
    );

  // Apply the per-category context profile (see lib/agents/turn-profile.ts).
  // The toggles fire AFTER buildHistoryWindow so the budget snapshot still
  // shows what we *would have* spent on hot/warm — useful when debugging
  // why an extension turn answered with the field's own context only.
  const profile = req.context_profile;
  // include_hot=false strips PRIOR thread history but must keep the current
  // turn's user message, otherwise the LLM is called with only a system
  // prompt (e.g. Gemini rejects with "contents is not specified").
  const effectiveHistory = profile && profile.include_hot === false
    ? [{ role: "user" as const, content }]
    : historyWindow.history;
  const effectiveWarmSummary = profile && profile.include_warm === false
    ? ""
    : historyWindow.warmSummaryCtx;
  const effectiveFacts = profile && profile.include_facts === false
    ? ""
    : historyWindow.factsCtx;
  const recallCtx = rawRecallCtx.text;

  // Numbered source manifest, shown to the agent for `[N]` markers and
  // persisted on the assistant row so the chat UI can resolve markers →
  // clickable links/anchors. Built from every source the agent has touched
  // in this thread (tool calls), plus the user's memory items, plus prior
  // assistant turns — see ADR-0044. Empty (and the prompt block becomes a
  // "no sources yet" note) when strictness is `off` or the thread is fresh.
  // Pre-turn manifest: empty in practice. The agent hasn't called any
  // tools yet on this turn, so there are no `[N]` numbers it could
  // attach. Citations for THIS turn happen in two ways:
  //   1. Mid-prose markdown links `[label](https://…)` for sources the
  //      agent fetches while drafting (web_search/web_fetch/file_read
  //      results it just got back).
  //   2. Numeric `[N]` markers resolved AFTER the turn finishes — the
  //      post-turn manifest refresh in `persistAssistantMessage` appends
  //      this-turn tool + delegate sources and numbers them.
  // Old design dragged in every source from every prior turn in the
  // thread plus 10 memory items plus 10 dialog anchors — produced a
  // 38-entry panel of mostly-irrelevant noise on every reply. Dropped.
  const strictness = parseCitationStrictness(agentCfg.citation_strictness) ?? "off";
  const sourceManifest: SourceManifestEntry[] = [];
  void strictness; // strictness is read again at persist-time

  const ownsSignalDelivery = !req._system_signal_batch;
  const canDeliverSignals = !req.history_bridge_key && !req.delivery_channel
    && req.user_category !== "bridge" && req.context_profile?.history_scope !== "none";
  const signalDelivery = req._system_signal_batch ?? (canDeliverSignals
    ? claimSystemSignals(agentCfg.id, req.thread_id, runtimeInstanceId())
    : { agentId: agentCfg.id, threadId: req.thread_id, leaseToken: "", signals: [] });
  req = { ...req, _system_signal_batch: signalDelivery };
  const systemPrompt = buildSystemPrompt({
    agentCfg,
    trimmedMessage: trimmed,
    budget: historyWindow.budget,
    recallCtx,
    warmSummaryCtx: effectiveWarmSummary,
    factsCtx: effectiveFacts,
    backgroundActivityCtx: historyWindow.backgroundActivityCtx,
    systemSignals: signalDelivery.signals,
    runtimeInstanceId: runtimeInstanceId(),
    surroundingsCtx,
    conversationGapCtx: buildConversationGapContext(idleMsBeforeTurn, CONVERSATION_GAP_HINT_MS),
    experienceMode: resolveExperienceMode(req.options),
    delegateRosterLines,
    sourceManifest,
    deliveryChannel: req.delivery_channel ?? null,
    usageStrategyInstruction: usageProfile.promptInstruction,
    autoRecallEnabled,
    autoFactsEnabled,
    allowedTools,
    toolPermissionMap,
  });

  const delegationDepth = req._delegation_depth ?? 0;
  const delegationAncestors = req._delegation_ancestors ?? [];
  const toolCredentialOverrides = getAgentToolCredentials(agentCfg);
  const streamOpts: StreamOptions = {
    ...req.options,
    agent_run_config: {
      signal_continuation: req._system_signal_continuation,
      system_prompt: systemPrompt,
      allowed_tools: allowedTools,
      tool_permission_map: toolPermissionMap.map((entry) => ({
        name: entry.name,
        category: entry.category,
        capability: entry.capability,
        source: entry.source,
        permission: entry.permission ?? "disabled",
        permission_reason: entry.permission_reason ?? null,
      })),
      model_config_name: modelConfigName,
      route_decision: routeDecision,
      output_reserve_tokens: historyWindow.budget.outputReserveTokens,
      context_window_tokens: runContextWindow,
      max_output_tokens: adaptiveOutputTokenCap,
      thinking_params: thinkingReduction?.params,
      tool_credentials: Object.keys(toolCredentialOverrides).length > 0 ? toolCredentialOverrides : undefined,
      delegation: delegationDepth > 0 || delegationAncestors.length > 0
        ? { depth: delegationDepth, ancestors: delegationAncestors }
        : undefined,
      delegation_budget: req._delegation_budget,
    },
  };

  // Retry paths may need to append an explicit non-persisted message (for
  // example a stall/transient nudge) to the in-memory history for THIS run
  // only. Never infer that from the main request message, or retries will
  // duplicate the already-persisted user prompt in model context.
  const finalHistory = appendHistoryMessage(effectiveHistory, req._history_append_message);

  // A dedicated controller for THIS attempt, chained from the caller's own
  // signal (Stop button / run abort still works normally) but independently
  // abortable. stallRetryStream aborts it right before starting a stall/loop
  // retry, so the abandoned attempt's still-in-flight provider call is
  // actually cancelled instead of left running behind the new attempt
  // (ADR-0089) — without this, breaking out of the consumer loop on a
  // detected tool-loop does nothing to stop the underlying HTTP call.
  const attemptAbort = new AbortController();
  if (req.signal) {
    if (req.signal.aborted) attemptAbort.abort(req.signal.reason);
    else req.signal.addEventListener("abort", () => attemptAbort.abort(req.signal!.reason), { once: true });
  }
  const rawStream = streamWithConfig(req.thread_id, finalHistory, streamOpts, attemptAbort.signal);
  // Preserve the effective per-turn router policy as the retry seed. Without
  // this, transient retries fall back to the global policy whenever the
  // initial request didn't carry an explicit _router_policy_override, which
  // makes per-agent router_policy appear to "revert" during retries.
  const retrySeedReq: ThreadRunRequest = req._router_policy_override === undefined
    ? { ...req, _router_policy_override: routePolicy }
    : req;
  const transientRetriesLeft = Math.min(
    req._transient_retries_left ?? maxTransientRetries(),
    usageProfile.providerFailureRetries ?? Number.POSITIVE_INFINITY,
  );
  const transientWrapped = transientRetryStream(rawStream, retrySeedReq, transientRetriesLeft, prepareThreadRun);
  const retriesLeft = Math.min(
    req._stall_retries_left ?? maxStallRetries(),
    usageProfile.stallRetries ?? Number.POSITIVE_INFINITY,
  );
  // Overhead = the assembled system prompt + per-message scaffolding, which
  // is more accurate than the budget's static overhead allowance.
  const overheadTokens = estimateTokens(systemPrompt);
  // One-shot callers (extension fill/rewrite) consume `assistantContent` as
  // raw text. The stall-retry wrapper would otherwise leak the `↻` separator
  // and the pre-retry stalled prose into the user's input field, and the
  // strict-citation audit (which lives inside the same wrapper) would do
  // the same with retry continuations. Bypass it entirely for those callers.
  const stream = req.disable_quality_gates || isDelegatedRun
    ? transientWrapped
    : stallRetryStream(transientWrapped, req, allowedTools, retriesLeft, attemptAbort, prepareThreadRun);
  return {
    signal_delivery: signalDelivery,
    stream: ownsSignalDelivery ? (async function* () {
      let succeeded = false;
      let renewedAt = Date.now();
      try {
        for await (const chunk of stream) {
          if (Date.now() - renewedAt > 10_000) {
            renewSystemSignalLease(signalDelivery);
            renewedAt = Date.now();
          }
          if (chunk.type === "done" && !chunk.data.aborted && !req.signal?.aborted) succeeded = true;
          yield chunk;
        }
      } finally {
        if (!succeeded) releaseSystemSignals(signalDelivery);
      }
    })() : stream,
    thread_id: req.thread_id,
    context_snapshot: {
      context_window_tokens: historyWindow.budget.contextWindowTokens,
      hot_tokens: profile && profile.include_hot === false ? 0 : historyWindow.tierUsage.hot_tokens,
      warm_tokens: profile && profile.include_warm === false ? 0 : historyWindow.tierUsage.warm_tokens,
      facts_tokens: profile && profile.include_facts === false ? 0 : historyWindow.tierUsage.facts_tokens,
      overhead_tokens: overheadTokens,
      hot_budget_tokens: historyWindow.budget.tierBudgets.hot,
      warm_budget_tokens: historyWindow.budget.tierBudgets.warm,
      facts_budget_tokens: historyWindow.budget.tierBudgets.facts,
    },
    source_manifest: sourceManifest.length > 0 ? sourceManifest : undefined,
    route_decision: routeDecision,
    memory_recall: rawRecallCtx.memoryHits > 0 || rawRecallCtx.messageHits > 0
      ? { memory_hits: rawRecallCtx.memoryHits, message_hits: rawRecallCtx.messageHits }
      : undefined,
  };
}

export interface AssistantUsageSnapshot {
  input_tokens: number;
  output_tokens: number;
  // Anthropic prompt-cache breakdown (PR #181). Disjoint from input_tokens:
  // total billable input = input_tokens + cache_creation + cache_read,
  // priced at 1×, 1.25×, and 0.1× the input rate respectively.
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  // Thinking/reasoning tokens: Gemini thoughtsTokenCount, OpenAI reasoning_tokens.
  // Already included in output_tokens for billing; stored separately for display.
  thinking_tokens?: number;
  provider: string;
  model_id: string;
  model_config_name: string | null;
}

// Footer appended to an assistant message that was cut off by the user
// (Stop button or steer-while-streaming). Both human readers and the LLM
// see this on the next turn — the agent treats it as "the previous reply
// was abandoned; the user's next message is the new direction".
export const INTERRUPT_MARKER = "*⏸ Interrupted by user.*";

/** Append the interrupt footer to a (possibly empty) partial reply. */
export function withInterruptMarker(partial: string): string {
  const trimmed = partial.trim();
  if (!trimmed) return INTERRUPT_MARKER;
  if (trimmed.endsWith(INTERRUPT_MARKER)) return trimmed;
  return `${trimmed}\n\n${INTERRUPT_MARKER}`;
}

export function persistAssistantMessage(
  thread_id: string,
  content: string,
  usedTools?: readonly string[],
  toolEvents?: readonly PersistedToolEvent[],
  category: string | null = null,
  usage?: AssistantUsageSnapshot | null,
  contextSnapshot?: ContextUsageSnapshot | null,
  sourceManifest?: readonly SourceManifestEntry[] | null,
  routeDecision?: RouteDecisionMetadata | null,
  messageMetadata?: Record<string, unknown> | null,
  signalDelivery?: SystemSignalBatch,
  finalization?: {
    draftMessageId?: string | null;
    transcriptStatus?: MessageTranscriptStatus;
    statusReason?: string | null;
  },
): void {
  const trimmed = content.trim();
  let final = trimmed;
  const toolList = usedTools ? Array.from(new Set(usedTools.filter(Boolean))) : [];
  // Skip stall + fabrication footers when the user explicitly interrupted
  // the run — the message wasn't a model stall, it was a deliberate stop,
  // and the interrupt marker already explains the cut to both reader and
  // the next agent turn.
  const wasInterrupted = trimmed.endsWith(INTERRUPT_MARKER);
  // Stall detector: model ended its turn with a promise-shaped tail but
  // either invoked no tool, OR called only read-only tools while
  // narrating a write. Both shapes look identical to the user — a chat
  // bubble that ends mid-task — so the warning footer covers both.
  // The retry budget (MAX_STALL_AUTO_RETRIES) is exhausted by the time
  // we hit this code path, so the footer is the user's manual recovery
  // affordance: "Reply continue".
  const isStallProse = !!trimmed && !wasInterrupted && looksLikeStall(trimmed);
  const noTool = toolList.length === 0;
  const noWriteTool = toolList.length > 0 && !toolList.some(isWriteLikeToolName);
  if (isStallProse && (noTool || noWriteTool)) {
    final = `${trimmed}\n\n*⚠️ Agent stalled — promised a next step but did not invoke a write tool. Reply "continue" to retry.*`;
  }
  // Fabrication footer (ADR-0037): runs after the retry budget is exhausted
  // and a flagged reply still made it through. Look up allowed tools from
  // the agent config so callers don't have to thread it through.
  if (trimmed && !wasInterrupted && !final.includes("*⚠️ Agent stalled")) {
    const allowedTools = lookupAllowedToolsForThread(thread_id);
    const v = validateAssistantOutput(trimmed, toolList, allowedTools, toolList.filter(isWriteLikeToolName));
    if (!v.ok) {
      final = `${final}\n\n*⚠️ Output validator flagged: ${v.reason}*`;
    }
  }
  // Cap individual tool payloads so a single 64KB file_read result doesn't
  // make every reload of this thread re-download a giant blob. Keep the
  // first ~8KB — enough to be useful, small enough to be cheap.
  const sanitizedEvents = toolEvents && toolEvents.length > 0
    ? toolEvents.map(capToolEventPayload)
    : null;
  // Strip the `?autoplay=1` hint that generate_voice embeds in /api/v1/files
  // URLs before persistence. Autoplay is a transient signal for the live
  // streaming client only — reloading the thread, scrolling back, or opening
  // the conversation from another browser must not replay TTS clips the user
  // has already heard.
  const withoutAutoplay = stripAutoplayHints(final);
  // Split the optional trailing ```jarela-references` JSON block off the
  // body before persistence. The block is a machine-readable list of
  // {label, href} pairs the agent declared as its sources for this turn;
  // we merge it into the manifest below. The body stored in
  // messages.content is the clean prose without the fence.
  const { body: persisted, refs: declaredRefs } = extractDeclaredReferences(withoutAutoplay);
  const attachmentReferences = collectTurnFileReferences(thread_id, toolEvents);
  const hasSignalReceipt = !persisted && !sanitizedEvents?.length && !!signalDelivery?.signals.length && !wasInterrupted;
  if (hasSignalReceipt && !finalization?.draftMessageId) {
    commitSystemSignalTranscript(signalDelivery, () => {
      addMessage(thread_id, "assistant", "System signals processed.", null, "system_signal", {
        system_signal_receipt: signalDelivery.signals.map((signal) => signal.id),
      });
    });
  }
  if (persisted || (sanitizedEvents && sanitizedEvents.length > 0) || finalization?.draftMessageId || finalization?.transcriptStatus) {
    const persistRow = () => {
      const rowCategory = hasSignalReceipt
        ? "system_signal"
        : finalization?.transcriptStatus === "failed"
        && !persisted
        && !sanitizedEvents?.length
        ? "run_error"
        : category;
      const rowContent = hasSignalReceipt && finalization?.draftMessageId
        ? "System signals processed."
        : persisted;
      const rowMetadata = hasSignalReceipt
        ? {
            ...(messageMetadata ?? {}),
            system_signal_receipt: signalDelivery!.signals.map((signal) => signal.id),
          }
        : messageMetadata ?? null;
      const row = finalization?.draftMessageId
        ? updateMessageContent(finalization.draftMessageId, rowContent, {
            toolEvents: sanitizedEvents,
            category: rowCategory,
            metadata: rowMetadata,
            transcriptStatus: finalization.transcriptStatus ?? "completed",
            statusReason: finalization.statusReason ?? null,
          })
        : addMessage(
            thread_id,
            "assistant",
            rowContent,
            sanitizedEvents,
            rowCategory,
            rowMetadata,
            finalization?.transcriptStatus ?? "completed",
            finalization?.statusReason ?? null,
          );
      if (!row) throw new Error("Assistant transcript draft could not be finalized");
      if (attachmentReferences.length > 0) {
        mergeMessageMetadata(row.msg_id, {
          attachment_handling: {
            version: 1,
            interpretation_message_id: row.msg_id,
            references: attachmentReferences,
          } satisfies AttachmentHandlingMetadata,
        });
      }
      return row;
    };
    const row = signalDelivery && !wasInterrupted
      ? commitSystemSignalTranscript(signalDelivery, persistRow)
      : persistRow();
    if (sanitizedEvents && sanitizedEvents.length > 0) {
      recordToolUsage(sanitizedEvents, persisted, {
        workflowName: category ?? "assistant_turn",
        eventType: category ?? "assistant_turn",
        extractionValid: persisted.length > 0,
      });
    }
    // Per ADR-0064 transparency requirement: surface what was held back
    // from the LLM during this turn on the assistant message's metadata.
    // The shield indicator in the chat UI reads this to render
    // "Held back from LLM: 1 anthropic_api_key, 1 personnummer" tooltips.
    const redactionSummary = getMaskRunContext()?.totalSummary() ?? [];
    if (redactionSummary.length > 0) {
      mergeMessageMetadata(row.msg_id, { redaction_summary: redactionSummary });
    }
    if (routeDecision) {
      mergeMessageMetadata(row.msg_id, { routing: routeDecision });
    }
    // Persist the source manifest for THIS reply into the message's
    // metadata. The chat UI uses it to resolve inline `[N]` markers →
    // clickable links and to populate the References panel.
    //
    // Scope: ONLY this turn's tool events + this turn's delegate replies.
    // We deliberately don't include prior-turn sources, memory items, or
    // earlier-dialog anchors — each reply's panel must reflect what backs
    // THAT reply, otherwise the panel turns into a 40-entry haystack of
    // stale links from unrelated topics across the thread (real user
    // complaint, 2026-06-07: "there are so many irrelevant citation").
    //
    // The agent's mid-prose markdown links `[label](url)` need no
    // manifest entry — they linkify themselves.
    let manifest: SourceManifestEntry[] = [];
    if (sanitizedEvents && sanitizedEvents.length > 0) {
      const thread = getThread(thread_id);
      const agent = thread?.agent_id ? getAgentConfig(thread.agent_id) : null;
      const strictness = agent ? parseCitationStrictness(agent.citation_strictness) ?? "off" : "off";
      if (strictness !== "off") {
        manifest = buildCombinedManifest(sanitizedEvents, thread_id, {
          tools: getConfig().citationManifestMax,
          delegates: 10,
        });
      }
    }
    // Fold the agent's declared refs into the manifest (dedup by
    // normalized href). These are appended after tool-derived entries
    // and renumbered. Skipped when strictness is `off` so off-mode
    // agents that ignore the fence don't suddenly get a References
    // panel (the strictness gate is the user's switch for this whole
    // feature).
    if (declaredRefs.length > 0) {
      const thread = getThread(thread_id);
      const agent = thread?.agent_id ? getAgentConfig(thread.agent_id) : null;
      const strictness = agent ? parseCitationStrictness(agent.citation_strictness) ?? "off" : "off";
      if (strictness !== "off") {
        manifest = mergeDeclaredReferences(manifest, declaredRefs);
      }
    }
    if (manifest.length > 0) {
      // Merge so a redaction_summary written above survives.
      mergeMessageMetadata(row.msg_id, {
        citations: {
          checker_model: "",
          claims: [],
          unverified_links: [],
          sources: manifest.map((e) => ({ n: e.n, label: e.label, href: e.href })),
        },
      });
    }
    // Citation checker (fire-and-forget). Runs only when the agent's
    // `citation_strictness` is not `off`, the persisted text is non-empty,
    // the manifest is non-empty, and (at standard/informational levels)
    // the text actually carries at least one `[N]` marker to verify.
    // Strict mode skips the marker pre-check so the audit can flag
    // missing citations. Writes its verdict back into `messages.metadata`
    // alongside the manifest; the UI picks it up on the next refresh.
    // Any failure (timeout, parse error, missing checker model) leaves
    // the manifest in place and the message renders normally.
    // Delegated inference must remain inside the shared per-inference budget.
    // The post-persist checker calls a provider directly, outside llm.ts's
    // budget hook, so delegated results keep their deterministic manifest but
    // skip this optional model-based audit.
    if (category !== "delegation" && persisted && manifest.length > 0) {
      void runCitationCheckerForRow(thread_id, row.msg_id, persisted, manifest);
    }
    // ADR-0041 wrote provider-reported token usage when available. The
    // per-tier context snapshot (hot/warm/facts/overhead) is computed
    // locally and is meaningful even when the provider didn't emit a
    // usage event (custom proxies, mid-stream errors, providers that
    // omit usage on tool turns), so persist the row whenever EITHER side
    // has data. The cost/rate columns simply stay null when there are
    // no provider tokens to price.
    const hasProviderUsage = !!(usage && (usage.input_tokens > 0 || usage.output_tokens > 0));
    if (hasProviderUsage || contextSnapshot) {
      try {
        const thread = getThread(thread_id);
        const agentId = thread?.agent_id ?? "";
        const agent = agentId ? getAgentConfig(agentId) : null;
        const agentName = agent?.name ?? agentId;
        const tables = getPricingTables();
        const rates = hasProviderUsage
          ? modelRatesFor(tables, usage!.provider, usage!.model_id)
          : { inputPer1M: null, outputPer1M: null };
        const cacheCreation = hasProviderUsage ? (usage!.cache_creation_input_tokens ?? 0) : 0;
        const cacheRead = hasProviderUsage ? (usage!.cache_read_input_tokens ?? 0) : 0;
        const thinking = hasProviderUsage ? (usage!.thinking_tokens ?? 0) : 0;
        const cost = hasProviderUsage
          ? estimateProviderCostUsd(usage!.provider, usage!.input_tokens, usage!.output_tokens, rates, {
              cache_creation_input_tokens: cacheCreation,
              cache_read_input_tokens: cacheRead,
            })
          : 0;
        recordMessageUsage({
          message_id: row.msg_id,
          thread_id,
          agent_id: agentId,
          agent_name: agentName,
          provider: hasProviderUsage ? usage!.provider : "",
          model_id: hasProviderUsage ? usage!.model_id : "",
          model_config_name: hasProviderUsage ? usage!.model_config_name : null,
          input_tokens: hasProviderUsage ? usage!.input_tokens : 0,
          output_tokens: hasProviderUsage ? usage!.output_tokens : 0,
          input_rate_usd_per_mtok: rates.inputPer1M,
          output_rate_usd_per_mtok: rates.outputPer1M,
          cost_usd: cost,
          cache_creation_input_tokens: cacheCreation > 0 ? cacheCreation : null,
          cache_read_input_tokens: cacheRead > 0 ? cacheRead : null,
          thinking_tokens: thinking > 0 ? thinking : null,
          tier_usage: contextSnapshot
            ? {
                hot_tokens: contextSnapshot.hot_tokens,
                warm_tokens: contextSnapshot.warm_tokens,
                facts_tokens: contextSnapshot.facts_tokens,
                overhead_tokens: contextSnapshot.overhead_tokens,
                hot_budget_tokens: contextSnapshot.hot_budget_tokens,
                warm_budget_tokens: contextSnapshot.warm_budget_tokens,
                facts_budget_tokens: contextSnapshot.facts_budget_tokens,
                context_window_tokens: contextSnapshot.context_window_tokens,
              }
            : null,
        });
      } catch (err) {
        console.error("[message_usage] snapshot failed", err);
      }
    }
  }
}

function collectTurnFileReferences(
  thread_id: string,
  toolEvents?: readonly PersistedToolEvent[],
): FileReferenceMetadata[] {
  const references = new Map<string, FileReferenceMetadata>();
  const recentMessages = getMessagesPage(thread_id, 50).messages;
  const latestMessage = recentMessages[recentMessages.length - 1];
  const latestUser = latestMessage?.role === "user" ? latestMessage : null;
  if (latestUser?.content.startsWith("[")) {
    try {
      const parts = JSON.parse(latestUser.content) as ContentPart[];
      for (const part of parts) {
        const reference = fileReferenceFromContentPart(part);
        if (reference) references.set(`${reference.storage}:${reference.ref}`, reference);
      }
    } catch {
      // Legacy/plain message content has no structured attachment refs.
    }
  }

  const calls = new Map<string, string>();
  for (const event of toolEvents ?? []) {
    if (event.phase === "call") {
      const args = asRecord(event.payload);
      calls.set(event.id, unwrapInvokedToolName(event.name, args));
      continue;
    }
    const calledTool = calls.get(event.id) ?? event.name;
    if (calledTool !== "file_read") continue;
    let payload = parseToolEventPayload(event.payload);
    if (event.name === "invoke_tool" && payload && typeof payload === "object") {
      payload = parseToolEventPayload((payload as { result?: unknown }).result);
    }
    if (!payload || typeof payload !== "object") continue;
    const reference = (payload as { attachment_reference?: unknown }).attachment_reference;
    if (!isFileReferenceMetadata(reference)) continue;
    references.set(`${reference.storage}:${reference.ref}`, reference);
  }
  return [...references.values()];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseToolEventPayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

/**
 * Fire-and-forget citation checker. Gated by the agent's
 * `citation_strictness` and the existence of a checker model. The checker
 * is intentionally permissive about failure — anything that goes wrong
 * (no model, provider throw, parse failure, timeout) leaves the manifest-
 * only metadata in place so the chat UI still renders `[N]` markers as
 * links.
 */
async function runCitationCheckerForRow(
  thread_id: string,
  msg_id: string,
  persistedText: string,
  sourceManifest: readonly SourceManifestEntry[],
): Promise<void> {
  try {
    const thread = getThread(thread_id);
    const agent = thread?.agent_id ? getAgentConfig(thread.agent_id) : null;
    if (!agent) return;
    const strictness = parseCitationStrictness(agent.citation_strictness) ?? "off";
    if (strictness === "off") return;
    const checkerModel = (agent.anti_hallucination_model_config ?? "").trim();
    if (!checkerModel) return;
    // Strict mode runs the checker even when the agent emitted no markers
    // (it should have cited every claim — the audit will flag the
    // missing ones). Standard / informational skip the LLM round-trip
    // when there's literally nothing to verify, as a cost guard.
    if (strictness !== "strict" && extractCitedMarkers(persistedText).length === 0) return;
    const verdict = await classifyCitations(persistedText, sourceManifest, checkerModel);
    if (!verdict) return;
    // Use merge so we don't clobber redaction_summary written by the
    // run loop earlier (ADR-0064 transparency).
    mergeMessageMetadata(msg_id, {
      citations: {
        ...verdict,
        sources: sourceManifest.map((e) => ({ n: e.n, label: e.label, href: e.href })),
      },
    });
  } catch (err) {
    console.error("[citation-checker] failed", err);
  }
}

// Removes `autoplay=1` from /api/v1/files/*.{wav,mp3,...} URLs that appear in
// the assistant text. Handles it as the sole query param (`?autoplay=1`) or
// combined with others (`?foo=bar&autoplay=1`, `?autoplay=1&foo=bar`).
function stripAutoplayHints(text: string): string {
  if (!text || !text.includes("autoplay=1")) return text;
  return text.replace(
    /(\/api\/v1\/files\/[^\s)"']+?\.(?:wav|mp3|ogg|webm|m4a))(\?[^\s)"']*)/gi,
    (_full, base: string, query: string) => {
      const cleaned = query
        .replace(/[?&]autoplay=1\b/g, "")
        .replace(/^&/, "?");
      return cleaned === "?" || cleaned === "" ? base : `${base}${cleaned}`;
    },
  );
}

// Resolve the agent's allowed_tools list from a thread id. Best-effort: empty
// list if the thread or agent config has gone away (the validator then
// flags any `(via foo)` citation as unregistered, which is the safe default).
function lookupAllowedToolsForThread(thread_id: string): string[] {
  const thread = getThread(thread_id);
  if (!thread) return [];
  const agentCfg = getAgentConfig(thread.agent_id);
  return withDefaultTools(getAgentTools(agentCfg), getDefaultAgentToolNames());
}

// Run semantic recall on the user's turn, format the top hits as a system-prompt
// block. Empty string when no embeddings configured or no good matches.
async function buildRecallContext(
  current_thread_id: string,
  query: string,
  windowOldestContent: string | null,
  surroundingsQuery = "",
): Promise<{ text: string; memoryHits: number; messageHits: number }> {
  const ambient = surroundingsQuery.trim();
  const empty = { text: "", memoryHits: 0, messageHits: 0 };
  if (!query.trim() && !ambient) return empty;
  const memoryPolicy = getMemoryPolicy();
  const limit = memoryPolicy === "important" ? 4 : memoryPolicy === "detailed" ? 12 : 8;
  let hits: RecalledMemory[];
  let ambientHits: RecalledMemory[] = [];
  try {
    // A second pass keyed on the page the user is on, so notes about a site
    // surface when they return to it without having to name it.
    [hits, ambientHits] = await Promise.all([
      query.trim() ? recall(query, limit) : Promise.resolve([]),
      ambient ? recall(ambient, Math.min(4, limit)) : Promise.resolve([]),
    ]);
  } catch {
    return empty;
  }
  hits = mergeRecallHits(hits, ambientHits);
  if (hits.length === 0) return empty;

  // Drop matches that already live in the in-prompt history window.
  const filtered = hits.filter((h) => {
    if (h.source === "message" && h.thread_id === current_thread_id) {
      // crude but cheap: skip if it's the same content as anything in the window
      return windowOldestContent !== h.content;
    }
    return true;
  });
  if (filtered.length === 0) return empty;

  const similarPriorUserRequests = filtered.filter(
    (h) => h.source === "message" && h.role === "user" && h.score >= 0.3,
  );

  const lines = [
    "--- Your retrieved memory for this turn ---",
    "These entries were pulled from YOUR own memory store (not user-supplied just now).",
    "Treat them as facts you previously committed to remember. Cite them confidently when relevant.",
    "",
  ];
  if (similarPriorUserRequests.length >= 2) {
    lines.push(
      `Repeated-task signal: this user turn resembles ${similarPriorUserRequests.length} prior user requests. If your response confirms this is the same workflow, briefly summarize the common pattern and ask whether the user wants a reusable skill created or updated before persisting one.`,
      "",
    );
  }
  for (const h of filtered) {
    const stamp = h.created_at.slice(0, 10);
    if (h.source === "memory") {
      lines.push(`• [memory ${h.namespace}/${h.key}, ${stamp}] ${truncate(h.content, 280)}`);
    } else {
      const tag = h.thread_id === current_thread_id ? "earlier this thread" : "past chat";
      lines.push(`• [${tag} · ${h.role}, ${stamp}] ${truncate(h.content, 280)}`);
    }
  }
  return {
    text: lines.join("\n"),
    memoryHits: filtered.filter((h) => h.source === "memory").length,
    messageHits: filtered.filter((h) => h.source === "message").length,
  };
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/** Union of two recall passes, keeping the better score for a repeated hit. */
function mergeRecallHits(
  primary: readonly RecalledMemory[],
  secondary: readonly RecalledMemory[],
): RecalledMemory[] {
  const byKey = new Map<string, RecalledMemory>();
  for (const hit of [...primary, ...secondary]) {
    const key = hit.source === "memory"
      ? `memory:${hit.namespace}/${hit.key}`
      : `message:${hit.thread_id}:${hit.content.slice(0, 120)}`;
    const existing = byKey.get(key);
    if (!existing || hit.score > existing.score) byKey.set(key, hit);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}

/**
 * True for turns the user is actually present for. Automation runners
 * (scheduler, watcher, trigger, extension one-shots) are excluded from
 * ambient surroundings: they fire on their own schedule, and whatever page
 * the user happened to be on at that moment is not their subject.
 */
function isForegroundConversationTurn(req: ThreadRunRequest): boolean {
  if (req._skip_persist_message) return false;
  if (req.context_profile && req.context_profile.include_hot === false) return false;
  const category = req.user_category ?? null;
  return category === null;
}

export function shouldEmitChunk(
  chunkType: StreamChunk["type"],
  options?: StreamOptions,
): boolean {
  const includeTools = options?.filters?.include_tools ?? true;
  const includeThinking = options?.filters?.include_thinking ?? true;
  if (!includeTools && (chunkType === "tool_call" || chunkType === "tool_result" || chunkType === "tool_progress")) return false;
  if (!includeThinking && chunkType === "thinking_delta") return false;
  return true;
}

export { contentText };
