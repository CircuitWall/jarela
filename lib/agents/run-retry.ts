import { isWriteToolNameSegment, STALL_NOW_ACTION_VERBS, STALL_TAIL_PHRASES } from "@/lib/agents/action-vocabulary";
import { getConfig } from "@/lib/env/config";
import { setTimeout as delay } from "node:timers/promises";
import type { StreamChunk } from "@/lib/agents/base";
import { registeredCapability } from "@/lib/tools/runtime/registry";
import { getThread } from "@/lib/stores/threads";
import { getAgentConfig, parseCitationStrictness } from "@/lib/stores/agent-configs";
import { validateAssistantOutput } from "@/lib/agents/output-validator";
import { buildWorkflowStepRetryNudge, collectWorkflowContractFailures, planWorkflowStepRetries, WORKFLOW_TURN_AUTO_RETRY_LIMIT, workflowProgressArgs, type WorkflowProgressObservation } from "@/lib/agents/workflow-step-retry";
import { type ThreadRunRequest } from "@/lib/agents/prepare";
import { classifyStall, resolveDetector, type StallVerdict } from "@/lib/agents/hallucination-classifier";
import { nextPolicyForRetry } from "@/lib/agents/model-router";
import { buildCombinedManifest, classifyCitations } from "@/lib/agents/citation-checker";
import type { PreparedThreadRun } from "@/lib/agents/run-thread";
import { ToolOutcomes, unwrapInvokedToolName } from "./tool-outcomes";
import { buildFabricationNudge, buildCitationRetryNudge } from "./retry-prompts";
export { buildFabricationNudge } from "./retry-prompts";
export { unwrapInvokedToolName } from "./tool-outcomes";

type PrepareRetry = (request: ThreadRunRequest) => Promise<Pick<PreparedThreadRun, "stream">>;


export function transientRetryDelayMs(attempt: number): number {
  const clamped = Math.max(1, attempt);
  return Math.min(8_000, 500 * (2 ** (clamped - 1)));
}


export const MAX_RATE_LIMIT_RETRY_AFTER_MS = 60_000;


export function rateLimitRetryDelayMs(attempt: number, retryAfterMs = 0): number {
  return Math.max(transientRetryDelayMs(attempt), Math.max(0, retryAfterMs));
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


export async function* transientRetryStream(
  inner: AsyncIterable<StreamChunk>,
  originalReq: ThreadRunRequest,
  retriesLeft: number,
  prepareRetry: PrepareRetry,
): AsyncGenerator<StreamChunk> {
  if (retriesLeft <= 0) {
    yield* inner;
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

  const data = errorChunk.data as { code?: unknown; message?: unknown; retry_after_ms?: unknown } | undefined;
  const code = typeof data?.code === "string" ? data.code : "";
  const message = typeof data?.message === "string" ? data.message : "";
  const retryAfterMs = typeof data?.retry_after_ms === "number" && Number.isFinite(data.retry_after_ms)
    ? Math.max(0, data.retry_after_ms) : 0;
  if (code === "rate_limited" && retryAfterMs > MAX_RATE_LIMIT_RETRY_AFTER_MS) {
    yield errorChunk;
    return;
  }
  if (sawVisibleOutput || !shouldRetryTransientError(code, message)) {
    yield errorChunk;
    return;
  }

  const attempt = Math.max(1, getConfig().maxTransientRetries - retriesLeft + 1);
  const backoffMs = code === "rate_limited"
    ? rateLimitRetryDelayMs(attempt, retryAfterMs)
    : transientRetryDelayMs(attempt);
  const nextPolicy = nextPolicyForRetry(originalReq._router_policy_override ?? getConfig().modelRouterPolicy);
  console.warn(`[transient-retry] attempt=${attempt} thread=${originalReq.thread_id} code=${code || "unknown"} backoff_ms=${backoffMs} policy=${nextPolicy}`);
  try {
    await delay(backoffMs, undefined, { signal: originalReq.signal });
    originalReq.signal?.throwIfAborted();
  } catch (error) {
    if (!originalReq.signal?.aborted) throw error;
    yield { type: "error", data: { code: "aborted", message: "Run stopped during retry backoff." } };
    return;
  }

  const retry = await prepareRetry({
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
  yield* retry.stream;
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
export async function* stallRetryStream(
  inner: AsyncIterable<StreamChunk>,
  originalReq: ThreadRunRequest,
  allowedTools: readonly string[],
  retriesLeft: number,
  attemptAbort: AbortController,
  prepareRetry: PrepareRetry,
): AsyncGenerator<StreamChunk> {
  let textBuf = "";
  const toolNames: string[] = [];
  const toolResultSummaries: string[] = [];
  // Track (name, args) signatures within the turn so we can detect a
  // ReAct loop where the model spins on the same tool call. Counts
  // increment only on tool_call chunks; tool_result echoes are ignored.
  const signatureCounts = new Map<string, number>();
  const toolOutcomes = new ToolOutcomes();
  // workflow_progress calls (direct or proxied) awaiting their result, so the
  // step contract can be checked from observed tool output at turn end.
  const pendingWorkflowArgs = new Map<string, Record<string, unknown>>();
  const workflowObservations: WorkflowProgressObservation[] = [];
  let loopedToolName: string | null = null;
  let doneChunk: StreamChunk | null = null;

  for await (const chunk of inner) {
    toolOutcomes.observe(chunk);
    if (chunk.type === "text_delta") {
      const d = (chunk.data as { delta?: unknown } | undefined)?.delta;
      if (typeof d === "string") textBuf += d;
      yield chunk;
    } else if (chunk.type === "tool_call") {
      const data = chunk.data as { id?: unknown; name?: unknown; arguments?: unknown } | undefined;
      const rawName = typeof data?.name === "string" ? data.name : "";
      const args = data?.arguments && typeof data.arguments === "object"
        ? (data.arguments as Record<string, unknown>)
        : {};
      const name = unwrapInvokedToolName(rawName, args);
      if (name) {
        toolNames.push(name);
        if (typeof data?.id === "string") {
          const workflowArgs = workflowProgressArgs(rawName, args);
          if (workflowArgs) pendingWorkflowArgs.set(data.id, workflowArgs);
        }
        const sig = toolCallSignature(rawName, args);
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
          if (retriesLeft > 0) {
            yield chunk;
            break;
          }
        }
      }
      yield chunk;
    } else if (chunk.type === "tool_result") {
      const data = chunk.data as { id?: unknown; name?: unknown; result?: unknown } | undefined;
      const name = typeof data?.name === "string" ? data.name : "tool";
      if (typeof data?.id === "string" && pendingWorkflowArgs.has(data.id)) {
        workflowObservations.push({ args: pendingWorkflowArgs.get(data.id), result: data.result });
        pendingWorkflowArgs.delete(data.id);
      }
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
      yield chunk;
      return;
    } else {
      yield chunk;
    }
  }

  const succeededToolNames = toolOutcomes.successfulNames();

  const trimmedText = textBuf.trim();
  const isStallProse = trimmedText.length > 0 && looksLikeStall(trimmedText);
  // The original stall path: model produced narration but called nothing.
  const zeroToolStall = toolNames.length === 0 && isStallProse;
  // The "promised next-step" path: model DID call read-only tools, ended
  // the turn with stall prose ("Writing it now", "Saving the file now"),
  // and never invoked a write-like tool. Real failure from the wild — the
  // read+narrate+stop loop slipped past the zero-tool gate. Uses
  // succeededToolNames — a write attempt that was rejected/errored (most
  // commonly a proxied invoke_tool call) must still count as "no write
  // tool ran", or a genuinely stalled turn is silently waved through.
  const promisedWriteStall =
    !zeroToolStall &&
    isStallProse &&
    toolNames.length > 0 &&
    !succeededToolNames.some(isWriteLikeToolName);
  const regexStalled = zeroToolStall || promisedWriteStall;
  const looped = loopedToolName !== null;

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
  let classifierVerdict: StallVerdict | null = null;
  if (retriesLeft > 0 && !looped && detector.mode === "model") {
    classifierVerdict = await classifyStall(textBuf, succeededToolNames, detector.modelConfigName, originalReq.signal)
      .catch(() => null);
    if (!classifierVerdict) {
      // Classifier unavailable / errored / aborted — fall back to regex
      // for THIS turn so the agent isn't left ungovernable.
      console.warn(
        `[anti-hallucination] classifier unavailable, falling back to regex for thread ${originalReq.thread_id} (model=${detector.modelConfigName || "<unset>"})`,
      );
    }
  }
  const classifierStalled = classifierVerdict?.stalled ?? false;
  const classifierReason = classifierVerdict?.reason ?? "";

  // Effective stall verdict per the resolved mode:
  //   off    → no stall detection (whatever the regex thought, ignore)
  //   regex  → regex verdict
  //   model  → classifier verdict if we got one, else regex fallback
  let stalled = false;
  if (detector.mode === "regex") {
    stalled = regexStalled;
  } else if (detector.mode === "model") {
    stalled = classifierVerdict?.stalled ?? regexStalled;
  }

  // Fabrication check (ADR-0037): only run when no other path claimed
  // this turn. hasWriteEvidence must reflect a CONFIRMED write, not merely
  // an attempted one — see succeededToolNames above.
  const fabrication = !stalled && !looped
    ? validateAssistantOutput(textBuf, toolNames, allowedTools, succeededToolNames.filter(isWriteLikeToolName))
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
    !stalled && !looped && fabrication.ok
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
    if (workflowObservations.length > 0) {
      yield* workflowStepRetryStream(workflowObservations, originalReq, retriesLeft, attemptAbort, doneChunk, textBuf, toolNames, toolResultSummaries, prepareRetry);
      return;
    }
    if (doneChunk) yield doneChunk;
    return;
  }

  const writeLikeTools = [...new Set(toolOutcomes.possiblyChangedNames().filter(isWriteLikeToolName))];
  if (writeLikeTools.length > 0) {
    yield {
      type: "text_delta",
      data: {
        delta:
          `\n\n*⚠️ Retry guard skipped automatic retry because state-changing tools were attempted this turn: ${writeLikeTools.slice(0, 6).join(", ")}. Their effects may be incomplete or unverified. Review the result before continuing to avoid duplicate side effects.*`,
      },
    };
    if (doneChunk) yield doneChunk;
    return;
  }

  if (retriesLeft <= 0) {
    yield {
      type: "text_delta",
      data: {
        delta: "\n\n*⚠️ Automatic quality retry is disabled for this usage strategy. Review the result before continuing.*",
      },
    };
    if (doneChunk) yield doneChunk;
    return;
  }

  // A stall/loop retry continues a legitimate partial answer, so the prior
  // prose stays visible with a "↻" separator. A fabrication/citation retry
  // (ADR-0037) is different: the COMPLETED reply itself is what's wrong, so
  // the correct move is to discard it, not append a correction after it —
  // otherwise the user (and the persisted message) ends up with both the
  // flagged reply and its replacement (issue #576). `reset_text` tells the
  // client buffer and the persistence collector to drop what they've
  // accumulated for this turn; only the retry's own chunks land after it.
  const isReplaceRetry = !stalled && !looped;
  if (!isReplaceRetry) {
    // Visible separator between the stalled prose and the retry
    // continuation, so the user can see something is being re-attempted.
    yield { type: "text_delta", data: { delta: "\n\n↻ " } };
  } else {
    yield { type: "status", data: { phase: "validating", label: "Checking answer..." } };
  }

  // Inject a forceful nudge as a synthetic user message so the model sees
  // its own flagged reply + an instruction to continue. Each failure mode
  // gets its own reason-aware nudge.
  let nudge: string;
  if (looped) {
    nudge = `↻ Auto-retry: you called \`${loopedToolName}\` ${TOOL_LOOP_THRESHOLD}+ times in this turn with the same arguments without making progress. Either invoke a DIFFERENT tool to advance the task (for example, if you intend to write a file, call \`file_write\` now), or stop and explain what's blocking. Do NOT call \`${loopedToolName}\` again with the same arguments.`;
  } else if (stalled && promisedWriteStall) {
    nudge = `↻ Auto-retry: your reply ended with a 'writing/saving/creating ... now' style statement but you only called read-only tools (${[...new Set(toolNames)].slice(0, 6).join(", ")}) — no write-like tool was invoked. Don't narrate the next step; CALL the actual write tool now (e.g. file_write, file_edit, memory_write). If you cannot, stop and explain why.`;
  } else if (stalled && zeroToolStall) {
    nudge = "↻ Auto-retry: your previous reply ended with a 'one moment' style promise but you didn't call any tool, which ends the turn with nothing happening. Continue the original task NOW by invoking the appropriate tool. Do not acknowledge, do not apologize — just call the tool.";
  } else if (stalled && classifierStalled) {
    nudge = `↻ Auto-retry: the anti-hallucination classifier flagged your reply as a stall (${classifierReason || "promise without a write tool"}). Don't narrate the next step; either CALL the actual tool that fulfils what you promised, or stop and explain why you can't.`;
  } else if (citationFail) {
    nudge = buildCitationRetryNudge(uncitedHighClaims);
  } else {
    nudge = buildFabricationNudge("reason" in fabrication ? fabrication.reason : "");
  }

  const retryContext = buildRetryContextSummary(isReplaceRetry ? "" : textBuf, toolNames, toolResultSummaries);
  const draftContext = isReplaceRetry ? `Original answer to revise (verify its action claims):\n${textBuf}` : "";
  const nudgeWithContext = [nudge, draftContext, retryContext].filter(Boolean).join("\n\n");

  // Cancel this attempt's own provider call before starting the retry — the
  // consumer loop above already stopped reading (via `break` on tool-loop
  // detection, or naturally via `doneChunk`), but that alone never aborted
  // the underlying HTTP request. Without this, an abandoned attempt can keep
  // running a tool call in the background while the retry starts a second,
  // unrelated one.
  if (originalReq.signal?.aborted) {
    yield { type: "error", data: { code: "aborted", message: "Run stopped before automatic correction." } };
    return;
  }
  attemptAbort.abort("stall_retry");

  const retry = await prepareRetry({
    ...originalReq,
    message: nudgeWithContext,
    attachments: undefined,
    _stall_retries_left: retriesLeft - 1,
    _retry_count: (originalReq._retry_count ?? 0) + 1,
    // The nudge is in-memory only — never write it to `messages`. What ends
    // up persisted at end-of-turn via `persistAssistantMessage` is: for a
    // stall/loop retry, the flagged prose + "↻" + the retry (a genuine
    // continuation); a successful fabrication/citation retry atomically
    // replaces the draft with the complete corrected answer.
    // Without these flags the nudge becomes a permanent user-role row the
    // LLM mistakes for user input on every future turn.
    _skip_persist_message: true,
    _history_append_message: nudgeWithContext,
  });
  if (!isReplaceRetry) {
    yield* retry.stream;
    return;
  }
  let retryTextBuf = "";
  for await (const chunk of retry.stream) {
    if (chunk.type === "text_delta") {
      const d = (chunk.data as { delta?: unknown } | undefined)?.delta;
      if (typeof d === "string") retryTextBuf += d;
      continue;
    }
    if (chunk.type === "reset_text") {
      retryTextBuf = "";
      continue;
    }
    if (chunk.type === "done" && !chunk.data.aborted && !originalReq.signal?.aborted) {
      if (!retryTextBuf.trim()) {
        yield { type: "error", data: { code: "correction_failed", message: "Automatic correction returned no answer. The original draft is unchanged and may contain unverified claims." } };
        return;
      }
      yield { type: "reset_text", data: {} };
      yield { type: "text_delta", data: { delta: retryTextBuf } };
    }
    yield chunk;
  }
}


// Workflow step contract auto-retry. Runs only after every other quality
// gate passed, and has its own per-step budget (WORKFLOW_STEP_MAX_ATTEMPTS)
// so a stall retry earlier in the turn never starves it. The retry is an
// append-mode continuation: the turn's work stays visible, followed by the
// model redoing only the failed steps.
export async function* workflowStepRetryStream(
  observations: readonly WorkflowProgressObservation[],
  originalReq: ThreadRunRequest,
  stallRetriesLeft: number,
  attemptAbort: AbortController,
  doneChunk: StreamChunk | null,
  textBuf: string,
  toolNames: readonly string[],
  toolResultSummaries: readonly string[],
  prepareRetry: PrepareRetry,
): AsyncGenerator<StreamChunk> {
  const spent = originalReq._workflow_step_retries ?? {};
  const failures = collectWorkflowContractFailures(observations);
  const { retry, exhausted } = planWorkflowStepRetries(failures, spent);
  const spentTotal = Object.values(spent).reduce((sum, n) => sum + n, 0);

  if (retry.length === 0 || spentTotal >= WORKFLOW_TURN_AUTO_RETRY_LIMIT) {
    const unresolved = [...exhausted, ...retry];
    if (unresolved.length > 0) {
      console.warn(
        `[workflow-retry] contract still failing after auto-retry: ${unresolved.map((f) => f.key).join(", ")} thread=${originalReq.thread_id}`,
      );
      yield {
        type: "text_delta",
        data: {
          delta: `\n\n*⚠️ Workflow step${unresolved.length === 1 ? "" : "s"} still failing the step contract after automatic retries: ${unresolved.slice(0, 4).map((f) => `"${f.label}"`).join(", ")}. Use the step's retry button or review it manually.*`,
        },
      };
    }
    if (doneChunk) yield doneChunk;
    return;
  }

  console.warn(
    `[workflow-retry] retrying ${retry.map((f) => `${f.key}#${f.attempt}`).join(", ")} thread=${originalReq.thread_id}`,
  );
  yield { type: "text_delta", data: { delta: "\n\n↻ " } };
  const nudge = buildWorkflowStepRetryNudge(retry);
  const retryContext = buildRetryContextSummary(textBuf, [...toolNames], [...toolResultSummaries]);
  const nudgeWithContext = retryContext ? `${nudge}\n\n${retryContext}` : nudge;
  const nextSpent: Record<string, number> = { ...spent };
  for (const failure of retry) nextSpent[failure.key] = (nextSpent[failure.key] ?? 0) + 1;

  if (originalReq.signal?.aborted) {
    yield { type: "error", data: { code: "aborted", message: "Run stopped before workflow retry." } };
    return;
  }
  attemptAbort.abort("workflow_step_retry");
  const next = await prepareRetry({
    ...originalReq,
    message: nudgeWithContext,
    attachments: undefined,
    _stall_retries_left: stallRetriesLeft,
    _workflow_step_retries: nextSpent,
    _retry_count: (originalReq._retry_count ?? 0) + 1,
    _skip_persist_message: true,
    _history_append_message: nudgeWithContext,
  });
  for await (const chunk of next.stream) yield chunk;
}


const TOOL_LOOP_THRESHOLD = 3;


// A "write-like" tool, by name, is one whose path segments contain a CRUD
// verb. Per-segment match so e.g. `dataset_search` doesn't qualify on
// `set`. Used to flag the "called read-only tools then promised a write"
// stall pattern.
export function isWriteLikeToolName(name: string): boolean {
  if (!name) return false;
  // Built-ins declare their safety class at registration (ADR-0038), so trust
  // that over re-deriving it from the name — `propose_config_change` queues a
  // pending action but has no CRUD verb in it. MCP/external tools aren't in
  // the registry and still fall back to the verb scan.
  const capability = registeredCapability(name);
  if (capability) return capability !== "read";
  const segments = name.toLowerCase().split(/[._\-/]+/).filter(Boolean);
  return segments.some(isWriteToolNameSegment);
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


// A short clip reads to the model as "a snippet of what I said" rather than
// "the whole thing I said" — which pushed it to re-emit the full prior reply
// on retry instead of trusting that the recap already covers it (issue
// #577). 2000 chars covers the overwhelming majority of turns in full while
// still bounding the nudge's own token cost.
const RETRY_CONTEXT_CLIP_CHARS = 2000;


export function buildRetryContextSummary(
  text: string,
  toolNames: readonly string[],
  toolResults: readonly string[] = [],
): string {
  const parts: string[] = [];
  const trimmedText = text.trim();
  if (trimmedText) {
    const clipped = trimmedText.length > RETRY_CONTEXT_CLIP_CHARS
      ? `${trimmedText.slice(0, RETRY_CONTEXT_CLIP_CHARS - 3)}...`
      : trimmedText;
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


// Word-multiset containment: what fraction of `retry`'s tokens also appear
// in `original`. Order-insensitive and duplicate-aware (each token in
// `original` can only satisfy one token in `retry`), so a retry that mostly
// repeats the flagged reply verbatim — the failure mode issue #577
// describes — scores high regardless of minor rewording. Used only for
// telemetry: it flags regurgitation, it doesn't gate or alter rendering.
export function retryTextOverlapRatio(original: string, retry: string): number {
  const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const retryTokens = tokenize(retry);
  if (retryTokens.length === 0) return 0;
  const originalCounts = new Map<string, number>();
  for (const t of tokenize(original)) originalCounts.set(t, (originalCounts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of retryTokens) {
    const remaining = originalCounts.get(t) ?? 0;
    if (remaining > 0) {
      shared += 1;
      originalCounts.set(t, remaining - 1);
    }
  }
  return shared / retryTokens.length;
}


const STALL_PHRASE_GROUP = STALL_TAIL_PHRASES.join("|").replace(/ /g, "\\s+");

const STALL_NOW_VERB_GROUP = STALL_NOW_ACTION_VERBS.join("|");


const STALL_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:${STALL_PHRASE_GROUP})\\b`, "i"),
  /\bgive me (a|just a) (moment|sec(?:ond)?|minute)\b/i,
  /\blet me (try|do (?:that|this|it))\b/i,
  /\bi['’]?ll (check|verify|continue|proceed|look|try|do (?:that|this|it)|keep going|get (?:on|right) (?:on|to))/i,
  /\b(continuing|proceeding|working on it|moving on)\b.*[!.]?\s*$/i,
  // Aspirational future-action family: "Writing X now", "Saving the file
  // now", "Creating the report now". Catches the read-only-tools +
  // narrate-the-write + end-of-turn loop where the model promises a
  // write but never invokes the corresponding tool.
  new RegExp(`\\b(?:${STALL_NOW_VERB_GROUP})\\b[^.!?]*\\bnow\\b[!.]?\\s*$`, "i"),
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


export function looksLikeStall(text: string): boolean {
  // Inspect the last paragraph / sentence — earlier acknowledgment
  // language is fine when followed by real work. The stall signal is when
  // the message ends on a promise.
  const tail = text.split(/\n{2,}|(?<=[.!?])\s+/).filter(Boolean).slice(-2).join(" ");
  return STALL_PATTERNS.some((re) => re.test(tail));
}
