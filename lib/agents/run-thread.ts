import { streamWithConfig } from "@/lib/agents/llm";
import { getConfig } from "@/lib/env/config";
import type { StreamChunk, StreamOptions } from "@/lib/agents/base";
import type { ContentPart } from "@/lib/tools/types";
import { spillImageAttachments } from "@/lib/attachments/spill";
import { addMessage, getMessagesPage, getThread, mergeMessageMetadata, setThreadContextPin, touchThread, type PersistedToolEvent } from "@/lib/stores/threads";
import { getMaskRunContext } from "@/lib/redaction/context";
import { recordToolUsage } from "@/lib/stores/tool-stats";
import { getAgentConfig, getAgentTierProportions, getAgentTools, getAgentToolCredentials, parseCitationStrictness, parseDelegateTargets } from "@/lib/stores/agent-configs";
import { startScheduler } from "@/lib/scheduler";
import { recall, type RecalledMemory } from "@/lib/embeddings";
import { validateAssistantOutput } from "@/lib/agents/output-validator";
import { getDefaultModelConfig, getModelConfig, getModelParams, listModelConfigs } from "@/lib/stores/model-config";
import {
  buildHistoryWindow,
  buildSystemPrompt,
  resolveExperienceMode,
  type ThreadRunRequest,
} from "@/lib/agents/prepare";
import { getLatestMessageUsageForThread, recordMessageUsage } from "@/lib/stores/message-usage";
import { getPricingTables, modelRatesFor, estimateCostUsd, CACHE_READ_INPUT_RATE_MULTIPLIER } from "@/lib/stores/pricing";
import { estimateTokens } from "@/lib/agents/context-budget";
import { classifyStall, resolveDetector } from "@/lib/agents/hallucination-classifier";
import { nextPolicyForRetry, routeTurnModel, type ModelRouterPolicy, type RouteDecisionMetadata } from "@/lib/agents/model-router";
import {
  buildCombinedManifest,
  classifyCitations,
  extractCitedMarkers,
  extractDeclaredReferences,
  mergeDeclaredReferences,
  type SourceManifestEntry,
} from "@/lib/agents/citation-checker";

export type { ThreadRunRequest } from "@/lib/agents/prepare";

const SELF_CONFIG_TOOLS = [
  "propose_config_change",
  "check_proposal",
  "read_agent_instruction",
  "update_agent_instruction",
] as const;

function withSelfConfigTools(tools: string[]): string[] {
  return Array.from(new Set([...tools, ...SELF_CONFIG_TOOLS]));
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

export function transientRetryDelayMs(attempt: number): number {
  const clamped = Math.max(1, attempt);
  return Math.min(8_000, 500 * (2 ** (clamped - 1)));
}

export function shouldRetryTransientError(code: string | null | undefined, message: string | null | undefined): boolean {
  const normalized = (code ?? "").trim().toLowerCase();
  if (normalized === "rate_limited" || normalized === "empty_response" || normalized === "stream_error" || normalized === "agent_error") {
    return true;
  }
  if (normalized === "aborted" || normalized === "auth_failed" || normalized === "context_length_exceeded" || normalized === "recursion_limit" || normalized === "no_model") {
    return false;
  }
  const text = (message ?? "").toLowerCase();
  return /429|retry after|timed out|timeout|socket|eai_again|econnreset|fetch failed|temporar/i.test(text);
}

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

export function snapshotThreadModelConfigName(thread_id: string): string | null {
  const thread = getThread(thread_id);
  if (!thread) return null;

  const agentCfg = getAgentConfig(thread.agent_id);
  if (!agentCfg) return null;

  if (agentCfg.model_config_name) return agentCfg.model_config_name;
  if (getConfig().modelRouterMode !== "off") return null;
  return agentCfg.model_config_name ?? getDefaultModelConfig()?.name ?? null;
}

export function appendHistoryMessage(
  history: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>,
  injected: string | ContentPart[] | undefined,
): Array<{ role: "user" | "assistant"; content: string | ContentPart[] }> {
  return injected === undefined ? history : [...history, { role: "user", content: injected }];
}

/**
 * Per-turn entry point. Validates the request, persists the user message,
 * builds the history window + system prompt, kicks off the LLM stream, and
 * wraps the result in `stallRetryStream` so flagged turns can auto-retry.
 *
 * The 7-positional-arg version was refactored into the `ThreadRunRequest`
 * shape in ADR-0039. Internal control fields are `_`-prefixed; public
 * callers leave them undefined.
 */
export async function prepareThreadRun(req: ThreadRunRequest): Promise<PreparedThreadRun> {
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
  const allowedTools = withSelfConfigTools(getAgentTools(agentCfg));

  // Persist the user turn (including any attachments) before the LLM stream
  // so reload-mid-stream still shows the prompt. The stall-retry path sets
  // `_skip_persist_message` to keep its synthetic `↻ Auto-retry: …` nudges
  // out of the durable history — otherwise every nudge becomes a permanent
  // user-role row that the LLM mistakes for real user input on every future
  // turn.
  //
  // Spill inline `image` parts to disk before persist so `messages.content`
  // stores only lightweight refs — see ADR-0065 and lib/attachments/spill.ts.
  // Any provider that receives the message reads the ref back to base64 only
  // at HTTP invocation time.
  const spilledAttachments = req.attachments?.length
    ? await spillImageAttachments(req.attachments)
    : undefined;
  const content: string | ContentPart[] =
    spilledAttachments?.length ? [{ type: "text", text: trimmed }, ...spilledAttachments] : trimmed;
  const stored = typeof content === "string" ? content : JSON.stringify(content);
  if (!req._skip_persist_message) {
    addMessage(req.thread_id, "user", stored, undefined, req.user_category ?? null);
    touchThread(req.thread_id, trimmed.slice(0, 80) || undefined);
  }

  // Resolve model config + provider params (for both the live stream and
  // the warm-summary recursion inside buildHistoryWindow).
  const defaultModelConfig = getDefaultModelConfig();
  let modelConfigName = req._pinned_model_config_name
    ?? agentCfg.model_config_name
    ?? null;
  let routeDecision: RouteDecisionMetadata | null = null;
  if (req._pinned_model_config_name) {
    routeDecision = {
      source: "pinned",
      model_config_name: req._pinned_model_config_name,
      reason: "queued run reused the model pinned at submission time",
      retry_count: req._retry_count ?? 0,
    };
  } else if (agentCfg.model_config_name) {
    routeDecision = {
      source: "agent_override",
      model_config_name: agentCfg.model_config_name,
      reason: "agent has an explicit model_config_name override",
      retry_count: req._retry_count ?? 0,
    };
  }
  // Per-agent router settings override the global env vars.
  // router_enabled: 1 = force on, 0 = force off, null = follow global JARELA_MODEL_ROUTER_MODE.
  // router_policy: set = use this policy, null = follow global JARELA_MODEL_ROUTER_POLICY.
  const agentRouterEnabled = agentCfg.router_enabled ?? null;
  const useRouter = agentRouterEnabled === 1
    ? true
    : agentRouterEnabled === 0
    ? false
    : getConfig().modelRouterMode === "heuristic";
  const VALID_POLICIES: ReadonlySet<string> = new Set(["cheap", "fast", "balanced", "quality"]);
  const agentPolicy = agentCfg.router_policy && VALID_POLICIES.has(agentCfg.router_policy)
    ? agentCfg.router_policy as ModelRouterPolicy
    : null;
  const routePolicy = req._router_policy_override ?? agentPolicy ?? getConfig().modelRouterPolicy;
  if (!modelConfigName && useRouter) {
    const pricingTables = getPricingTables();
    const routed = routeTurnModel({
      models: listModelConfigs().map((cfg) => ({
        name: cfg.name,
        provider: cfg.provider,
        model_id: cfg.model_id,
        params: getModelParams(cfg),
        credential_id: cfg.credential_id ?? null,
        is_default: cfg.is_default === 1,
        created_at: cfg.created_at,
        updated_at: cfg.updated_at,
      })),
      message: trimmed,
      attachments: req.attachments,
      allowedTools,
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
  const baseProviderParams = getModelParams(modelCfg);

  // ADR-0043 — per-agent override of context_tier_proportions. The agent's
  // value, when set, replaces the model's default for THIS run only; the
  // stream LLM call below still uses the unmodified params. Splitting them
  // keeps the override scoped to the budget computation.
  const agentTierProportions = getAgentTierProportions(agentCfg);
  const providerParams = agentTierProportions
    ? { ...baseProviderParams, context_tier_proportions: agentTierProportions }
    : baseProviderParams;

  // ADR-0042. Persist the user-chosen boundary before we build the window so
  // the history fetch and the cached-summary lookup both see the same pin.
  // `null` clears the pin; `undefined` leaves whatever's already on the row.
  if (req.hot_since !== undefined) {
    setThreadContextPin(req.thread_id, req.hot_since);
  }
  const effectiveHotSince = req.hot_since !== undefined ? req.hot_since : (thread.hot_since ?? null);

  const historyWindow = await buildHistoryWindow(
    req.thread_id,
    agentCfg,
    providerParams,
    trimmed,
    { providerName: modelCfg?.provider, modelId: modelCfg?.model_id },
    effectiveHotSince,
  );

  const delegateRosterLines = buildDelegateRoster(agentCfg, allowedTools);

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
  const rawRecallCtx = req.context_profile && req.context_profile.include_recall === false
    ? ""
    : await raceWithBudget(
      buildRecallContext(req.thread_id, trimmed, oldestInWindow),
      recallWaitBudgetMs,
      "",
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
  const recallCtx = rawRecallCtx;

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

  const systemPrompt = buildSystemPrompt({
    agentCfg,
    trimmedMessage: trimmed,
    budget: historyWindow.budget,
    recallCtx,
    warmSummaryCtx: effectiveWarmSummary,
    factsCtx: effectiveFacts,
    experienceMode: resolveExperienceMode(req.options),
    delegateRosterLines,
    sourceManifest,
    deliveryChannel: req.delivery_channel ?? null,
  });

  const delegationDepth = req._delegation_depth ?? 0;
  const delegationAncestors = req._delegation_ancestors ?? [];
  const toolCredentialOverrides = getAgentToolCredentials(agentCfg);
  const streamOpts: StreamOptions = {
    ...req.options,
    agent_run_config: {
      system_prompt: systemPrompt,
      allowed_tools: allowedTools,
      model_config_name: modelConfigName,
      route_decision: routeDecision,
      output_reserve_tokens: historyWindow.budget.outputReserveTokens,
      tool_credentials: Object.keys(toolCredentialOverrides).length > 0 ? toolCredentialOverrides : undefined,
      delegation: delegationDepth > 0 || delegationAncestors.length > 0
        ? { depth: delegationDepth, ancestors: delegationAncestors }
        : undefined,
    },
  };

  // Retry paths may need to append an explicit non-persisted message (for
  // example a stall/transient nudge) to the in-memory history for THIS run
  // only. Never infer that from the main request message, or retries will
  // duplicate the already-persisted user prompt in model context.
  const finalHistory = appendHistoryMessage(effectiveHistory, req._history_append_message);

  const rawStream = streamWithConfig(req.thread_id, finalHistory, streamOpts, req.signal);
  // Preserve the effective per-turn router policy as the retry seed. Without
  // this, transient retries fall back to the global policy whenever the
  // initial request didn't carry an explicit _router_policy_override, which
  // makes per-agent router_policy appear to "revert" during retries.
  const retrySeedReq: ThreadRunRequest = req._router_policy_override === undefined
    ? { ...req, _router_policy_override: routePolicy }
    : req;
  const transientRetriesLeft = req._transient_retries_left ?? maxTransientRetries();
  const transientWrapped = transientRetryStream(rawStream, retrySeedReq, transientRetriesLeft);
  const retriesLeft = req._stall_retries_left ?? maxStallRetries();
  // Overhead = the assembled system prompt + per-message scaffolding, which
  // is more accurate than the budget's static overhead allowance.
  const overheadTokens = estimateTokens(systemPrompt);
  // One-shot callers (extension fill/rewrite) consume `assistantContent` as
  // raw text. The stall-retry wrapper would otherwise leak the `↻` separator
  // and the pre-retry stalled prose into the user's input field, and the
  // strict-citation audit (which lives inside the same wrapper) would do
  // the same with retry continuations. Bypass it entirely for those callers.
  const stream = req.disable_quality_gates
    ? transientWrapped
    : stallRetryStream(transientWrapped, req, allowedTools, retriesLeft);
  return {
    stream,
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
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function* transientRetryStream(
  inner: AsyncIterable<StreamChunk>,
  originalReq: ThreadRunRequest,
  retriesLeft: number,
): AsyncGenerator<StreamChunk> {
  if (retriesLeft <= 0) {
    for await (const chunk of inner) yield chunk;
    return;
  }

  let sawVisibleOutput = false;
  let errorChunk: StreamChunk | null = null;
  let doneChunk: StreamChunk | null = null;

  for await (const chunk of inner) {
    if (chunk.type === "text_delta" || chunk.type === "thinking_delta" || chunk.type === "tool_call" || chunk.type === "tool_result") {
      sawVisibleOutput = true;
      yield chunk;
      continue;
    }
    if (chunk.type === "done") {
      doneChunk = chunk;
      break;
    }
    if (chunk.type === "error") {
      errorChunk = chunk;
      break;
    }
    yield chunk;
  }

  if (doneChunk) {
    yield doneChunk;
    return;
  }
  if (!errorChunk) return;

  const data = errorChunk.data as { code?: unknown; message?: unknown } | undefined;
  const code = typeof data?.code === "string" ? data.code : "";
  const message = typeof data?.message === "string" ? data.message : "";
  if (sawVisibleOutput || !shouldRetryTransientError(code, message)) {
    yield errorChunk;
    return;
  }

  const attempt = Math.max(1, maxTransientRetries() - retriesLeft + 1);
  const backoffMs = transientRetryDelayMs(attempt);
  const nextPolicy = nextPolicyForRetry(originalReq._router_policy_override ?? getConfig().modelRouterPolicy);
  console.warn(`[transient-retry] attempt=${attempt} thread=${originalReq.thread_id} code=${code || "unknown"} backoff_ms=${backoffMs} policy=${nextPolicy}`);
  await delay(backoffMs);

  const retry = await prepareThreadRun({
    ...originalReq,
    _transient_retries_left: retriesLeft - 1,
    _skip_persist_message: true,
    _retry_count: (originalReq._retry_count ?? 0) + 1,
    _router_policy_override: originalReq._pinned_model_config_name ? (originalReq._router_policy_override ?? null) : nextPolicy,
  }).catch(() => null);
  if (!retry) {
    yield errorChunk;
    return;
  }
  for await (const chunk of retry.stream) yield chunk;
}

/**
 * Build the `--- Available delegates ---` block lines for the system prompt
 * when the agent has the `delegate_to_agent` tool allowed and at least one
 * resolvable delegate target. Empty array short-circuits the block.
 */
function buildDelegateRoster(
  agentCfg: { delegate_targets?: string | null },
  allowedTools: readonly string[],
): string[] {
  const delegateIds = parseDelegateTargets(agentCfg.delegate_targets);
  if (delegateIds.length === 0) return [];
  if (!allowedTools.includes("delegate_to_agent")) return [];

  return delegateIds
    .map((id) => {
      const child = getAgentConfig(id);
      if (!child) return null;
      const firstLine = (child.identity || child.instructions || "").split("\n")[0].slice(0, 120);
      return `  - ${child.id} — ${child.name}${firstLine ? `: ${firstLine}` : ""}`;
    })
    .filter((s): s is string => Boolean(s));
}

// Wraps the raw agent stream with stall-retry logic. Chunks pass through
// LIVE to the consumer (so the chat UI sees deltas as they arrive); we only
// hold the terminal `done` chunk so we can decide whether to retry. If the
// completed turn produced no tool calls AND the assistant text matches a
// "one moment"-style stall pattern, we inject a forceful nudge as a
// synthetic user message and forward the retry stream's chunks too. The
// stalled prose stays visible (already streamed) and a "↻" separator marks
// the boundary; the consumer's text/tool accumulator naturally captures
// both halves into a single combined assistant message.
async function* stallRetryStream(
  inner: AsyncIterable<StreamChunk>,
  originalReq: ThreadRunRequest,
  allowedTools: readonly string[],
  retriesLeft: number,
): AsyncGenerator<StreamChunk> {
  // If no retry budget, just forward everything unchanged. The downstream
  // persistAssistantMessage will still tag a stall or fabrication with a
  // warning footer.
  if (retriesLeft <= 0) {
    for await (const chunk of inner) yield chunk;
    return;
  }

  let textBuf = "";
  const toolNames: string[] = [];
  const toolResultSummaries: string[] = [];
  // Track (name, args) signatures within the turn so we can detect a
  // ReAct loop where the model spins on the same tool call. Counts
  // increment only on tool_call chunks; tool_result echoes are ignored.
  const signatureCounts = new Map<string, number>();
  let loopedToolName: string | null = null;
  let doneChunk: StreamChunk | null = null;
  let sawError = false;

  for await (const chunk of inner) {
    if (chunk.type === "text_delta") {
      const d = (chunk.data as { delta?: unknown } | undefined)?.delta;
      if (typeof d === "string") textBuf += d;
      yield chunk;
    } else if (chunk.type === "tool_call") {
      const data = chunk.data as { name?: unknown; arguments?: unknown } | undefined;
      const name = typeof data?.name === "string" ? data.name : "";
      const args = data?.arguments && typeof data.arguments === "object"
        ? (data.arguments as Record<string, unknown>)
        : {};
      if (name) {
        toolNames.push(name);
        const sig = toolCallSignature(name, args);
        const count = (signatureCounts.get(sig) ?? 0) + 1;
        signatureCounts.set(sig, count);
        if (count >= TOOL_LOOP_THRESHOLD && loopedToolName === null) {
          loopedToolName = name;
          // Leave a fingerprint so future loop incidents can be traced
          // to a specific provider/model — most often a sign the
          // aggregator's tool-use fidelity is poor (model narrates
          // "writing now" without emitting the corresponding tool_use
          // block).
          console.warn(
            `[stall-retry] tool-loop detected: tool=${name} repeats=${count} thread=${originalReq.thread_id}`,
          );
          yield chunk;
          break;
        }
      }
      yield chunk;
    } else if (chunk.type === "tool_result") {
      const data = chunk.data as { name?: unknown; result?: unknown } | undefined;
      const name = typeof data?.name === "string" ? data.name : "tool";
      const summary = summarizeRetryValue(data?.result).trim();
      if (summary) {
        const clipped = summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
        toolResultSummaries.push(`${name}: ${clipped}`);
      }
      yield chunk;
    } else if (chunk.type === "done") {
      // Hold the terminal marker — if we retry, the retry's `done` closes
      // the turn instead.
      doneChunk = chunk;
      break;
    } else if (chunk.type === "error") {
      sawError = true;
      yield chunk;
      return;
    } else {
      yield chunk;
    }
  }

  const trimmedText = textBuf.trim();
  const isStallProse = trimmedText.length > 0 && looksLikeStall(trimmedText);
  // The original stall path: model produced narration but called nothing.
  const zeroToolStall = !sawError && toolNames.length === 0 && isStallProse;
  // The "promised next-step" path: model DID call read-only tools, ended
  // the turn with stall prose ("Writing it now", "Saving the file now"),
  // and never invoked a write-like tool. Real failure from the wild — the
  // read+narrate+stop loop slipped past the zero-tool gate.
  const promisedWriteStall =
    !sawError &&
    !zeroToolStall &&
    isStallProse &&
    toolNames.length > 0 &&
    !toolNames.some(isWriteLikeToolName);
  const regexStalled = zeroToolStall || promisedWriteStall;
  const looped = !sawError && loopedToolName !== null;

  // Anti-hallucination detector — picks ONE method per turn (regex or
  // model), based on the resolved per-agent (or global env) settings.
  // The classifier and the regex never run together; the model is more
  // accurate but adds latency + cost, the regex is fast but brittle.
  const agentCfg = getAgentConfig(originalReq.thread_id ? (getThread(originalReq.thread_id)?.agent_id ?? "") : "");
  const detector = resolveDetector(agentCfg);
  // Strict citation mode forces the stall classifier to model-based:
  // strict turns are higher-stakes, so the more accurate (but more
  // expensive) LLM judge is worth the extra round-trip. Falls back to
  // regex automatically if the agent has no checker model configured.
  const strictness = agentCfg ? parseCitationStrictness(agentCfg.citation_strictness) : null;
  if (strictness === "strict" && detector.modelConfigName) {
    detector.mode = "model";
  }
  let classifierStalled = false;
  let classifierReason = "";
  if (!sawError && !looped && detector.mode === "model") {
    const verdict = await classifyStall(textBuf, toolNames, detector.modelConfigName, originalReq.signal)
      .catch(() => null);
    if (verdict) {
      classifierStalled = verdict.stalled;
      classifierReason = verdict.reason;
    } else {
      // Classifier unavailable / errored / aborted — fall back to regex
      // for THIS turn so the agent isn't left ungovernable.
      console.warn(
        `[anti-hallucination] classifier unavailable, falling back to regex for thread ${originalReq.thread_id} (model=${detector.modelConfigName || "<unset>"})`,
      );
    }
  }

  // Effective stall verdict per the resolved mode:
  //   off    → no stall detection (whatever the regex thought, ignore)
  //   regex  → regex verdict
  //   model  → classifier verdict if we got one, else regex fallback
  const stalled =
    detector.mode === "off"
      ? false
      : detector.mode === "regex"
        ? regexStalled
        : (classifierStalled || (classifierReason === "" && regexStalled)); // "model" mode

  // Fabrication check (ADR-0037): only run when no other path claimed
  // this turn.
  const fabrication = !sawError && !stalled && !looped
    ? validateAssistantOutput(textBuf, toolNames, allowedTools)
    : ({ ok: true } as const);

  // Strict-mode citation audit. Runs ONLY at `citation_strictness === 'strict'`
  // when no earlier gate already claimed the turn — that's when we want to
  // catch hallucinated/uncited high-impact claims and force a correction
  // round. Standard / informational defer to the post-persist fire-and-
  // forget checker (no nudge, just surfacing). The audit is synchronous so
  // it adds one checker round-trip to strict turns; the cost is the price
  // of the stronger guarantee.
  let uncitedHighClaims: ReadonlyArray<{ text: string; reason: string; marker: number | null }> = [];
  if (
    !sawError && !stalled && !looped && fabrication.ok
    && agentCfg
    && parseCitationStrictness(agentCfg.citation_strictness) === "strict"
    && retriesLeft > 0
    && textBuf.trim().length > 0
  ) {
    const checkerModel = (agentCfg.anti_hallucination_model_config ?? "").trim();
    if (checkerModel) {
      // The audit grades against THIS turn's sources. We don't accumulate
      // tool-result payloads in this scope (only names + signatures for
      // loop detection), so the audit can only see what landed in the
      // text — pass an empty events array and let `classifyCitations`
      // judge purely on the markers/links in the prose. The post-persist
      // checker (which runs against the persisted manifest) catches
      // anything this scope misses.
      const auditManifest = buildCombinedManifest([], originalReq.thread_id, {
        tools: Math.max(0, getConfig().citationManifestMax - 10),
        delegates: 10,
      });
      try {
        const verdict = await classifyCitations(textBuf, auditManifest, checkerModel, originalReq.signal);
        if (verdict) {
          uncitedHighClaims = verdict.claims
            .filter((c) => c.impact === "high" && !c.verified)
            .map((c) => ({ text: c.text, reason: c.reason, marker: c.marker }));
        }
      } catch { /* audit failed — fall through, no retry */ }
    }
  }
  const citationFail = uncitedHighClaims.length > 0;

  if (!stalled && !looped && fabrication.ok && !citationFail) {
    if (doneChunk) yield doneChunk;
    return;
  }

  // Visible separator between the stalled prose and the retry continuation,
  // so the user can see something is being re-attempted.
  yield { type: "text_delta", data: { delta: "\n\n↻ " } };

  // Inject a forceful nudge as a synthetic user message so the model sees
  // its own flagged reply + an instruction to continue. Each failure mode
  // gets its own reason-aware nudge.
  const nudge = looped
    ? `↻ Auto-retry: you called \`${loopedToolName}\` ${TOOL_LOOP_THRESHOLD}+ times in this turn with the same arguments without making progress. Either invoke a DIFFERENT tool to advance the task (for example, if you intend to write a file, call \`file_write\` now), or stop and explain what's blocking. Do NOT call \`${loopedToolName}\` again with the same arguments.`
    : promisedWriteStall
      ? `↻ Auto-retry: your reply ended with a 'writing/saving/creating ... now' style statement but you only called read-only tools (${[...new Set(toolNames)].slice(0, 6).join(", ")}) — no write-like tool was invoked. Don't narrate the next step; CALL the actual write tool now (e.g. file_write, file_edit, memory_write). If you cannot, stop and explain why.`
      : zeroToolStall
        ? "↻ Auto-retry: your previous reply ended with a 'one moment' style promise but you didn't call any tool, which ends the turn with nothing happening. Continue the original task NOW by invoking the appropriate tool. Do not acknowledge, do not apologize — just call the tool."
        : classifierStalled
          ? `↻ Auto-retry: the anti-hallucination classifier flagged your reply as a stall (${classifierReason || "promise without a write tool"}). Don't narrate the next step; either CALL the actual tool that fulfils what you promised, or stop and explain why you can't.`
          : citationFail
            ? `↻ Auto-retry: the citation audit flagged ${uncitedHighClaims.length} high-impact claim${uncitedHighClaims.length === 1 ? "" : "s"} without a verified source:\n${uncitedHighClaims.slice(0, 5).map((c, i) => `  ${i + 1}. ${c.text}${c.reason ? ` — ${c.reason}` : ""}`).join("\n")}\n\nFix each one in exactly ONE of these three ways:\n  (a) cite an existing source from the manifest by appending the marker \`[N]\` to the claim,\n  (b) call a tool now (file_read, web_search, fetch_webpage, memory_read, …) to actually ground the claim before stating it,\n  (c) rephrase plainly — drop the specific number/fact, or say "I don't have a source for this" — so the claim is no longer load-bearing.\n\nDo NOT just restate the same claim. Do NOT invent a marker number that isn't in the manifest.`
            : `↻ Auto-retry: output validator flagged your reply. ${"reason" in fabrication ? fabrication.reason : ""} Redo this turn without the false claim — either call the actual tool, or rephrase as a proposal/question.`;

  const retryContext = buildRetryContextSummary(textBuf, toolNames, toolResultSummaries);
  const nudgeWithContext = retryContext ? `${nudge}\n\n${retryContext}` : nudge;

  const retry = await prepareThreadRun({
    ...originalReq,
    message: nudgeWithContext,
    attachments: undefined,
    _stall_retries_left: retriesLeft - 1,
    _retry_count: (originalReq._retry_count ?? 0) + 1,
    // The nudge is in-memory only — never write it to `messages`. The
    // assistant's combined (original + ↻ + retry) text gets persisted
    // ONCE at end-of-turn via `persistAssistantMessage`, which is the
    // sole durable record of what happened. Without these flags the
    // nudge becomes a permanent user-role row the LLM mistakes for
    // user input on every future turn.
    _skip_persist_message: true,
    _history_append_message: nudgeWithContext,
  });
  for await (const chunk of retry.stream) yield chunk;
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
    const v = validateAssistantOutput(trimmed, toolList, allowedTools);
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
  if (persisted || (sanitizedEvents && sanitizedEvents.length > 0)) {
    const row = addMessage(thread_id, "assistant", persisted, sanitizedEvents, category);
    if (sanitizedEvents && sanitizedEvents.length > 0) {
      recordToolUsage(sanitizedEvents, persisted);
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
    if (persisted && manifest.length > 0) {
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
        // Anthropic: input_tokens is fresh-only; cache is additive at 0.1x.
        // OpenAI/Gemini: input_tokens includes cached portion; subtract it
        // and apply the provider-specific discount rate.
        const provider = hasProviderUsage ? usage!.provider : "";
        const isAnthropicCache = provider === "anthropic";
        const cacheReadMultiplier = provider === "gemini" ? 0.25
          : !isAnthropicCache && cacheRead > 0 ? 0.5
          : CACHE_READ_INPUT_RATE_MULTIPLIER;
        const freshInputTokens = hasProviderUsage
          ? (isAnthropicCache ? usage!.input_tokens : Math.max(0, usage!.input_tokens - cacheRead))
          : 0;
        const cost = hasProviderUsage
          ? estimateCostUsd(freshInputTokens, usage!.output_tokens, rates, {
              cache_creation_input_tokens: cacheCreation,
              cache_read_input_tokens: cacheRead,
              cache_read_rate_multiplier: cacheReadMultiplier,
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

const MAX_PERSISTED_PAYLOAD_BYTES = 8_000;

function capToolEventPayload(ev: PersistedToolEvent): PersistedToolEvent {
  try {
    const serialized = JSON.stringify(ev.payload);
    if (serialized.length <= MAX_PERSISTED_PAYLOAD_BYTES) return ev;
    return {
      ...ev,
      payload: {
        __truncated: true,
        preview: serialized.slice(0, MAX_PERSISTED_PAYLOAD_BYTES),
        original_bytes: serialized.length,
      },
    };
  } catch {
    return { ...ev, payload: { __truncated: true, error: "unserializable" } };
  }
}

const TOOL_LOOP_THRESHOLD = 3;

// A "write-like" tool, by name, is one whose path segments contain a CRUD
// verb. Per-segment match so e.g. `dataset_search` doesn't qualify on
// `set`. Used to flag the "called read-only tools then promised a write"
// stall pattern.
const WRITE_VERB_SEGMENTS = new Set([
  "write", "edit", "create", "update", "delete", "move", "copy", "mkdir",
  "add", "insert", "patch", "post", "put", "send", "publish", "save",
  "upload", "transition", "rank", "merge", "set", "schedule", "cancel",
]);

export function isWriteLikeToolName(name: string): boolean {
  if (!name) return false;
  const segments = name.toLowerCase().split(/[._\-/]+/).filter(Boolean);
  return segments.some((s) => WRITE_VERB_SEGMENTS.has(s));
}

// Stable signature of a tool call so repeated identical calls collapse to
// the same key. JSON.stringify with sorted keys is good enough — the
// argument shapes that matter here are small JSON objects, not graphs.
export function toolCallSignature(name: string, args: Record<string, unknown>): string {
  try {
    const sortedKeys = Object.keys(args).sort();
    const stable: Record<string, unknown> = {};
    for (const k of sortedKeys) stable[k] = args[k];
    return `${name}::${JSON.stringify(stable)}`;
  } catch {
    return `${name}::<unserializable>`;
  }
}

function summarizeRetryValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function buildRetryContextSummary(
  text: string,
  toolNames: readonly string[],
  toolResults: readonly string[] = [],
): string {
  const parts: string[] = [];
  const trimmedText = text.trim();
  if (trimmedText) {
    const clipped = trimmedText.length > 280 ? `${trimmedText.slice(0, 277)}...` : trimmedText;
    parts.push(`Already said this turn: ${clipped}`);
  }
  const uniqueTools = [...new Set(toolNames.filter(Boolean))];
  if (uniqueTools.length > 0) {
    parts.push(`Tools already used this turn: ${uniqueTools.slice(0, 8).join(", ")}`);
  }
  if (toolResults.length > 0) {
    parts.push(`Tool results already seen this turn:\n${toolResults.slice(0, 5).map((line, index) => `  ${index + 1}. ${line}`).join("\n")}`);
  }
  return parts.join("\n");
}

const STALL_PATTERNS: RegExp[] = [
  /\bone (moment|sec(?:ond)?)\b/i,
  /\bgive me (a|just a) (moment|sec(?:ond)?|minute)\b/i,
  /\bhold on\b/i,
  /\bjust a (moment|sec(?:ond)?|minute)\b/i,
  /\bbear with me\b/i,
  /\blet me (check|verify|continue|proceed|look|try|do (?:that|this|it))\b/i,
  /\bi['’]?ll (check|verify|continue|proceed|look|try|do (?:that|this|it)|keep going|get (?:on|right) (?:on|to))/i,
  /\b(continuing|proceeding|working on it|moving on)\b.*[!.]?\s*$/i,
  // Aspirational future-action family: "Writing X now", "Saving the file
  // now", "Creating the report now". Catches the read-only-tools +
  // narrate-the-write + end-of-turn loop where the model promises a
  // write but never invokes the corresponding tool.
  /\b(writing|saving|creating|updating|deleting|adding|appending|generating|drafting|pushing|sending|posting|moving|copying|renaming|editing|regenerating)\b[^.!?]*\bnow\b[!.]?\s*$/i,
  // Broader promise-shape: any "I'll <verb>" or "I will <verb>" followed
  // by "now" anywhere in the trailing clause. Catches "I will read it
  // now to understand the plan" / "I'll add the note now" — variants the
  // narrow aspirational-verb list above misses because the verb is in
  // bare infinitive form and `now` is mid-sentence rather than at the
  // end.
  /\b(?:i['’]?ll|i\s+will)\s+\w+\b[^.!?]*\bnow\b/i,
  // Present-continuous version: "I'm reading … now to figure out …" /
  // "I am updating the dashboard now to reflect …". Same idea, but the
  // model is narrating in progress rather than promising in future.
  // Same failure mode in practice — followed by no actual write call.
  /\b(?:i['’]?m|i\s+am)\s+\w+ing\b[^.!?]*\bnow\b/i,
];

// Resolve the agent's allowed_tools list from a thread id. Best-effort: empty
// list if the thread or agent config has gone away (the validator then
// flags any `(via foo)` citation as unregistered, which is the safe default).
function lookupAllowedToolsForThread(thread_id: string): string[] {
  const thread = getThread(thread_id);
  if (!thread) return [];
  const agentCfg = getAgentConfig(thread.agent_id);
  return withSelfConfigTools(getAgentTools(agentCfg));
}

export function looksLikeStall(text: string): boolean {
  // Inspect the last paragraph / sentence — earlier acknowledgment
  // language is fine when followed by real work. The stall signal is when
  // the message ends on a promise.
  const tail = text.split(/\n{2,}|(?<=[.!?])\s+/).filter(Boolean).slice(-2).join(" ");
  return STALL_PATTERNS.some((re) => re.test(tail));
}

// Run semantic recall on the user's turn, format the top hits as a system-prompt
// block. Empty string when no embeddings configured or no good matches.
async function buildRecallContext(
  current_thread_id: string,
  query: string,
  windowOldestContent: string | null,
): Promise<string> {
  if (!query.trim()) return "";
  let hits: RecalledMemory[];
  try {
    hits = await recall(query, 6);
  } catch {
    return "";
  }
  if (hits.length === 0) return "";

  // Drop matches that already live in the in-prompt history window.
  const filtered = hits.filter((h) => {
    if (h.source === "message" && h.thread_id === current_thread_id) {
      // crude but cheap: skip if it's the same content as anything in the window
      return windowOldestContent !== h.content;
    }
    return true;
  });
  if (filtered.length === 0) return "";

  const lines = [
    "--- Your retrieved memory for this turn ---",
    "These entries were pulled from YOUR own memory store (not user-supplied just now).",
    "Treat them as facts you previously committed to remember. Cite them confidently when relevant.",
    "",
  ];
  for (const h of filtered) {
    const stamp = h.created_at.slice(0, 10);
    if (h.source === "memory") {
      lines.push(`• [memory ${h.namespace}/${h.key}, ${stamp}] ${truncate(h.content, 280)}`);
    } else {
      const tag = h.thread_id === current_thread_id ? "earlier this thread" : "past chat";
      lines.push(`• [${tag} · ${h.role}, ${stamp}] ${truncate(h.content, 280)}`);
    }
  }
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

export function shouldEmitChunk(
  chunkType: StreamChunk["type"],
  options?: StreamOptions,
): boolean {
  const includeTools = options?.filters?.include_tools ?? true;
  const includeThinking = options?.filters?.include_thinking ?? true;
  if (!includeTools && (chunkType === "tool_call" || chunkType === "tool_result")) return false;
  if (!includeThinking && chunkType === "thinking_delta") return false;
  return true;
}

export { contentText };
