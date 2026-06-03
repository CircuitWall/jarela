import { streamWithConfig } from "@/lib/agents/llm";
import type { StreamChunk, StreamOptions } from "@/lib/agents/base";
import type { ContentPart } from "@/lib/tools/types";
import { addMessage, getThread, setThreadContextPin, touchThread, type PersistedToolEvent } from "@/lib/stores/threads";
import { recordToolUsage } from "@/lib/stores/tool-stats";
import { getAgentConfig, getAgentTierProportions, getAgentTools, parseDelegateTargets } from "@/lib/stores/agent-configs";
import { startScheduler } from "@/lib/scheduler";
import { recall, type RecalledMemory } from "@/lib/embeddings";
import { validateAssistantOutput } from "@/lib/agents/output-validator";
import { getDefaultModelConfig, getModelConfig, getModelParams } from "@/lib/stores/model-config";
import {
  buildHistoryWindow,
  buildSystemPrompt,
  resolveExperienceMode,
  type ThreadRunRequest,
} from "@/lib/agents/prepare";
import { recordMessageUsage } from "@/lib/stores/message-usage";
import { getPricingTables, modelRatesFor, estimateCostUsd } from "@/lib/stores/pricing";
import { estimateTokens } from "@/lib/agents/context-budget";

export type { ThreadRunRequest } from "@/lib/agents/prepare";

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
// than occasionally missing a memory hit.
const RECALL_BUDGET_MS = 400;

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

// Max times we'll auto-retry a single user turn when the model emits a
// "one moment" stall without firing any tool. One retry is plenty — if the
// model is *still* stalling after a forceful nudge, looping further just
// burns tokens and the warning footer on the persisted message gives the
// user a clear manual recovery path ("continue").
const MAX_STALL_AUTO_RETRIES = 1;

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

  // Persist the user turn (including any attachments) before the LLM stream
  // so reload-mid-stream still shows the prompt. The stall-retry path sets
  // `_skip_persist_message` to keep its synthetic `↻ Auto-retry: …` nudges
  // out of the durable history — otherwise every nudge becomes a permanent
  // user-role row that the LLM mistakes for real user input on every future
  // turn.
  const content: string | ContentPart[] =
    req.attachments?.length ? [{ type: "text", text: trimmed }, ...req.attachments] : trimmed;
  const stored = typeof content === "string" ? content : JSON.stringify(content);
  if (!req._skip_persist_message) {
    addMessage(req.thread_id, "user", stored, undefined, req.user_category ?? null);
    touchThread(req.thread_id, trimmed.slice(0, 80) || undefined);
  }

  // Resolve model config + provider params (for both the live stream and
  // the warm-summary recursion inside buildHistoryWindow).
  const modelCfg = agentCfg.model_config_name
    ? getModelConfig(agentCfg.model_config_name)
    : getDefaultModelConfig();
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

  const allowedTools = getAgentTools(agentCfg);
  const delegateRosterLines = buildDelegateRoster(agentCfg, allowedTools);

  // Recall is best-effort: cap on RECALL_BUDGET_MS so a cold embeddings
  // round-trip doesn't block the LLM stream from starting.
  const oldestInWindow = historyWindow.history.length > 0
    ? contentText(historyWindow.history[0].content)
    : null;
  const recallCtx = await raceWithBudget(
    buildRecallContext(req.thread_id, trimmed, oldestInWindow),
    RECALL_BUDGET_MS,
    "",
  );

  const systemPrompt = buildSystemPrompt({
    agentCfg,
    trimmedMessage: trimmed,
    budget: historyWindow.budget,
    recallCtx,
    warmSummaryCtx: historyWindow.warmSummaryCtx,
    factsCtx: historyWindow.factsCtx,
    experienceMode: resolveExperienceMode(req.options),
    delegateRosterLines,
  });

  const delegationDepth = req._delegation_depth ?? 0;
  const delegationAncestors = req._delegation_ancestors ?? [];
  const streamOpts: StreamOptions = {
    ...req.options,
    agent_run_config: {
      system_prompt: systemPrompt,
      allowed_tools: allowedTools,
      model_config_name: agentCfg.model_config_name ?? null,
      delegation: delegationDepth > 0 || delegationAncestors.length > 0
        ? { depth: delegationDepth, ancestors: delegationAncestors }
        : undefined,
    },
  };

  // Stall-retry path: the nudge needs to reach the LLM but isn't (and
  // shouldn't be) in the DB. Append it to the in-memory history just for
  // this LLM call. Use the structured `content` form (not the JSON-
  // stringified fallback) so attachments survive into the LLM call.
  const finalHistory = req._inject_message_into_history
    ? [...historyWindow.history, { role: "user" as const, content }]
    : historyWindow.history;

  const rawStream = streamWithConfig(req.thread_id, finalHistory, streamOpts, req.signal);
  const retriesLeft = req._stall_retries_left ?? MAX_STALL_AUTO_RETRIES;
  // Overhead = the assembled system prompt + per-message scaffolding, which
  // is more accurate than the budget's static overhead allowance.
  const overheadTokens = estimateTokens(systemPrompt);
  return {
    stream: stallRetryStream(rawStream, req, allowedTools, retriesLeft),
    thread_id: req.thread_id,
    context_snapshot: {
      context_window_tokens: historyWindow.budget.contextWindowTokens,
      hot_tokens: historyWindow.tierUsage.hot_tokens,
      warm_tokens: historyWindow.tierUsage.warm_tokens,
      facts_tokens: historyWindow.tierUsage.facts_tokens,
      overhead_tokens: overheadTokens,
      hot_budget_tokens: historyWindow.budget.tierBudgets.hot,
      warm_budget_tokens: historyWindow.budget.tierBudgets.warm,
      facts_budget_tokens: historyWindow.budget.tierBudgets.facts,
    },
  };
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
  const stalled = zeroToolStall || promisedWriteStall;
  const looped = !sawError && loopedToolName !== null;

  // Fabrication check (ADR-0037): only run when no other path claimed
  // this turn.
  const fabrication = !sawError && !stalled && !looped
    ? validateAssistantOutput(textBuf, toolNames, allowedTools)
    : ({ ok: true } as const);

  if (!stalled && !looped && fabrication.ok) {
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
        : `↻ Auto-retry: output validator flagged your reply. ${"reason" in fabrication ? fabrication.reason : ""} Redo this turn without the false claim — either call the actual tool, or rephrase as a proposal/question.`;

  const retry = await prepareThreadRun({
    ...originalReq,
    message: nudge,
    attachments: undefined,
    _stall_retries_left: retriesLeft - 1,
    // The nudge is in-memory only — never write it to `messages`. The
    // assistant's combined (original + ↻ + retry) text gets persisted
    // ONCE at end-of-turn via `persistAssistantMessage`, which is the
    // sole durable record of what happened. Without these flags the
    // nudge becomes a permanent user-role row the LLM mistakes for
    // user input on every future turn.
    _skip_persist_message: true,
    _inject_message_into_history: true,
  });
  for await (const chunk of retry.stream) yield chunk;
}

export interface AssistantUsageSnapshot {
  input_tokens: number;
  output_tokens: number;
  provider: string;
  model_id: string;
  model_config_name: string | null;
}

export function persistAssistantMessage(
  thread_id: string,
  content: string,
  usedTools?: readonly string[],
  toolEvents?: readonly PersistedToolEvent[],
  category: string | null = null,
  usage?: AssistantUsageSnapshot | null,
  contextSnapshot?: ContextUsageSnapshot | null,
): void {
  const trimmed = content.trim();
  // Append a small, persistent footer listing which tools actually ran this
  // turn. Without this, tool_call events are live-only UI — after the stream
  // ends (or on page reload, or if a mobile client missed the brief render)
  // the assistant text remains saying "I scheduled X" with no proof a tool
  // ran, which reads as a hallucination even when the tool did execute.
  let final = trimmed;
  const toolList = usedTools ? Array.from(new Set(usedTools.filter(Boolean))) : [];
  // Stall detector: model ended its turn with a "one moment" / "let me check"
  // promise but invoked no tool. The system prompt forbids this, but models
  // occasionally do it anyway. Marking the message inline gives the user a
  // concrete next-step ("type continue") instead of staring at silence.
  if (toolList.length === 0 && trimmed && looksLikeStall(trimmed)) {
    final = `${trimmed}\n\n*⚠️ Agent stalled — promised a next step but did not invoke any tool. Reply "continue" to retry.*`;
  } else if (toolList.length > 0) {
    final = `${trimmed}\n\n*— used: ${toolList.join(", ")}*`;
  }
  // Fabrication footer (ADR-0037): runs after the retry budget is exhausted
  // and a flagged reply still made it through. Look up allowed tools from
  // the agent config so callers don't have to thread it through.
  if (trimmed && !final.includes("*⚠️ Agent stalled")) {
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
  const persisted = stripAutoplayHints(final);
  if (persisted || (sanitizedEvents && sanitizedEvents.length > 0)) {
    const row = addMessage(thread_id, "assistant", persisted, sanitizedEvents, category);
    if (sanitizedEvents && sanitizedEvents.length > 0) {
      recordToolUsage(sanitizedEvents, persisted);
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
        const cost = hasProviderUsage
          ? estimateCostUsd(usage!.input_tokens, usage!.output_tokens, rates)
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

// Returns the FIRST tool name whose `(name, args)` signature appears
// `threshold` or more times in `events`. Empty names and threshold <= 0
// disable the check.
export function detectToolLoop(
  events: ReadonlyArray<{ name: string; args: Record<string, unknown> }>,
  threshold: number,
): string | null {
  if (threshold <= 0) return null;
  const counts = new Map<string, number>();
  for (const ev of events) {
    if (!ev.name) continue;
    const sig = toolCallSignature(ev.name, ev.args);
    const c = (counts.get(sig) ?? 0) + 1;
    counts.set(sig, c);
    if (c >= threshold) return ev.name;
  }
  return null;
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
];

// Resolve the agent's allowed_tools list from a thread id. Best-effort: empty
// list if the thread or agent config has gone away (the validator then
// flags any `(via foo)` citation as unregistered, which is the safe default).
function lookupAllowedToolsForThread(thread_id: string): string[] {
  const thread = getThread(thread_id);
  if (!thread) return [];
  const agentCfg = getAgentConfig(thread.agent_id);
  return getAgentTools(agentCfg);
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
