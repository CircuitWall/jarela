import { createReactAgent } from "@langchain/langgraph/prebuilt";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { getProvider } from "@/lib/providers";
import { ProviderAuthError, isAuthErrorMessage, isRetryableProviderStreamError } from "@/lib/providers/errors";
import { getModelParams, resolveRunnableModelConfig, upsertModelConfig } from "@/lib/stores/model-config";
import { getAllToolsAsync } from "@/lib/tools";
import { JarelaChatModel } from "@/lib/providers/jarela-chat-model";
import { SqliteMemoryStore } from "@/lib/stores/langgraph-store";
import { getCheckpointer } from "@/lib/agents/checkpointer";
import { drainSteering } from "@/lib/agents/run-registry";
import { readImageRef, readFileRef } from "@/lib/attachments/spill";
import type { ContentPart } from "@/lib/tools/runtime/types";
import type { StreamChunk, StreamOptions } from "./base";
import type { ProviderParams } from "@/lib/providers/types";
import { getConfig } from "@/lib/env/config";
import { withMaskRun, getMaskRunContext } from "@/lib/redaction/context";
import { StreamRehydrator } from "@/lib/redaction/stream-rehydrate";
import { wrapToolsForRehydrate } from "@/lib/redaction/wrap-tools";
import { wrapToolsForCredentialRouting } from "@/lib/tools/security/wrap-credentials";
import { errorMessage } from "@/lib/utils/error";
import { modelCapabilities } from "@/lib/providers/capabilities";
import { getKnownContextLength } from "@/lib/providers/known-context-windows";
import {
  isDelegationBudget,
  reserveDelegationCost,
  settleDelegationCost,
  type DelegationBudget,
  type DelegationCostReservation,
} from "@/lib/agents/delegation-budget";
import {
  CACHE_CREATION_INPUT_RATE_MULTIPLIER,
  estimateProviderCostUsd,
  getPricingTables,
  modelRatesFor,
} from "@/lib/stores/pricing";
import type { ProviderRates } from "@/lib/stores/pricing";

class DelegationCostBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegationCostBudgetError";
  }
}

interface InferenceUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

function isKnownCanonicalRate(rates: ProviderRates): boolean {
  return rates.ok && rates.inferred === false
    && typeof rates.inputPer1M === "number" && Number.isFinite(rates.inputPer1M) && rates.inputPer1M >= 0
    && typeof rates.outputPer1M === "number" && Number.isFinite(rates.outputPer1M) && rates.outputPer1M >= 0;
}

function maxInferenceCostUsd(
  rates: Pick<ProviderRates, "inputPer1M" | "outputPer1M">,
  contextWindowTokens: number,
  outputTokens: number,
): number {
  return (
    contextWindowTokens * rates.inputPer1M! * CACHE_CREATION_INPUT_RATE_MULTIPLIER
    + outputTokens * rates.outputPer1M!
  ) / 1_000_000;
}

function clipText(text: string, max: number): { value: string; truncated: boolean } {
  if (text.length <= max) return { value: text, truncated: false };
  return { value: text.slice(0, max), truncated: true };
}

// ADR-0090: an `image_ref`/`file_ref` only gets its bytes read back off disk
// for the newest message in the window — every earlier occurrence of the
// same ref (still fully intact on disk and in `messages.content`) collapses
// to this placeholder instead of being re-sent to the provider on every
// subsequent turn. `view_attachment` lets the model pull a `file_ref`'s text
// back on demand; images can only be re-surfaced as a URL (no provider tool
// result in this codebase carries a vision block — see docs/adr/0090).
function olderImagePlaceholder(name: string, media_type: string): string {
  return `[image attachment: ${name} (${media_type}) — attached earlier in this conversation and no longer shown here. `
    + `Call view_attachment({name: "${name}", media_type: "${media_type}"}) to get its URL again; you will not regain visual access to its pixels.]`;
}

function olderFilePlaceholder(name: string, filename: string, media_type: string): string {
  return `[file attachment: ${filename} (${name}, ${media_type}) — attached earlier in this conversation and no longer inlined here. `
    + `Call view_attachment({name: "${name}", media_type: "${media_type}"}) to read its contents again.]`;
}

export async function toBaseMessages(
  messages: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>,
  systemPrompt?: string,
  options?: { includeImages?: boolean },
): Promise<BaseMessage[]> {
  const base: BaseMessage[] = systemPrompt ? [new SystemMessage(systemPrompt)] : [];
  const out: BaseMessage[] = [...base];
  const lastIndex = messages.length - 1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isLatest = i === lastIndex;
    // Plain text path — fast & most common.
    if (typeof m.content === "string") {
      out.push(m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content));
      continue;
    }
    // Multi-modal path — translate our ContentPart[] into LangChain's
    // standard content-block array. Images become OpenAI-style
    // `image_url` blocks (the LangChain idiom that all major providers
    // accept on input). File attachments fall back to text so they
    // still reach text-only models. Assistant messages currently never
    // contain attachments in our flow, so we just flatten to text.
    if (m.role === "assistant") {
      const text = m.content
        .filter((p): p is ContentPart & { type: "text" } => p.type === "text")
        .map((p) => p.text).join("\n");
      out.push(new AIMessage(text));
      continue;
    }
    const blocks: Array<Record<string, unknown>> = [];
    for (const part of m.content) {
      if (part.type === "text") {
        if (part.text) blocks.push({ type: "text", text: part.text });
      } else if (part.type === "image") {
        if (options?.includeImages === false) {
          blocks.push({ type: "text", text: `[image attachment omitted: ${part.media_type}]` });
        } else {
          blocks.push({
            type: "image_url",
            image_url: { url: `data:${part.media_type};base64,${part.data}` },
          });
        }
      } else if (part.type === "image_ref") {
        if (options?.includeImages === false) {
          blocks.push({ type: "text", text: `[image attachment omitted: ${part.media_type}]` });
          continue;
        }
        if (!isLatest) {
          blocks.push({ type: "text", text: olderImagePlaceholder(part.name, part.media_type) });
          continue;
        }
        // Read the disk-resident blob and re-encode as base64 only for
        // the outbound provider request. The base64 lives on the wire
        // and inside the model's HTTP body — never in DB or checkpoints.
        try {
          const buf = await readImageRef({ media_type: part.media_type, name: part.name });
          blocks.push({
            type: "image_url",
            image_url: { url: `data:${part.media_type};base64,${buf.toString("base64")}` },
          });
        } catch (err) {
          // The file has been pruned / deleted / moved. Substitute a
          // text placeholder so the LLM sees SOMETHING coherent instead
          // of a missing part, and log so operators can trace it.
          console.warn(`[llm] image_ref ${part.name} unreadable, substituting text:`, errorMessage(err));
          blocks.push({ type: "text", text: `[image attachment unavailable: ${part.media_type}]` });
        }
      } else if (part.type === "file") {
        if (part.media_type.startsWith("text/") || part.media_type === "application/json") {
          blocks.push({ type: "text", text: `[Attached file: ${part.name}]\n${part.data}` });
        } else {
          blocks.push({ type: "text", text: `[Attached file: ${part.name} (${part.media_type})]` });
        }
      } else if (part.type === "file_ref") {
        if (!isLatest) {
          blocks.push({ type: "text", text: olderFilePlaceholder(part.name, part.filename, part.media_type) });
          continue;
        }
        const isTexty = part.media_type.startsWith("text/") || part.media_type === "application/json";
        if (!isTexty) {
          blocks.push({
            type: "text",
            text: `[Attached file: ${part.filename} (${part.media_type}); retained ref ${part.name}. `
              + `Call view_attachment({name: "${part.name}", media_type: "${part.media_type}"}) to retrieve it.]`,
          });
          continue;
        }
        try {
          const buf = await readFileRef({ name: part.name });
          const clipped = clipText(buf.toString("utf8"), getConfig().filesMaxReadBytes);
          blocks.push({
            type: "text",
            text: `[Attached file: ${part.filename}]\n${clipped.value}${clipped.truncated ? "\n[... truncated]" : ""}`,
          });
        } catch (err) {
          console.warn(`[llm] file_ref ${part.name} unreadable, substituting text:`, errorMessage(err));
          blocks.push({ type: "text", text: `[Attached file: ${part.filename} (${part.media_type}), unavailable]` });
        }
      }
    }
    // Cast through unknown — LangChain's strict block-union type rejects our
    // dynamic shape, but at runtime BaseMessage stores content as-is and
    // ChatModels consume whatever the provider's API expects (image_url for
    // OpenAI, image for Anthropic, etc.).
    out.push(new HumanMessage({ content: blocks as unknown as string }));
  }
  return out;
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

// Aggregator providers whose streamed `tool_call_chunks` carry no `index`
// never merge into a parsable `tool_calls` entry, so the turn would reach the
// transcript with results but no call — losing every argument. Fall back to
// the invalid and raw-fragment forms before giving up on a call id.
function collectToolCalls(
  chunk: AIMessageChunk,
): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  const out = new Map<string, { id: string; name: string; args: Record<string, unknown> }>();
  for (const tc of chunk.tool_calls ?? []) {
    if (tc.id) out.set(tc.id, { id: tc.id, name: tc.name ?? "", args: tc.args ?? {} });
  }
  for (const tc of chunk.invalid_tool_calls ?? []) {
    if (tc.id && !out.has(tc.id)) {
      out.set(tc.id, { id: tc.id, name: tc.name ?? "", args: parseToolArgs(tc.args) });
    }
  }
  // Raw fragments: same id can appear across several chunks, so join the
  // argument text in arrival order before parsing.
  const fragments = new Map<string, { name: string; args: string }>();
  for (const tc of chunk.tool_call_chunks ?? []) {
    if (!tc.id || out.has(tc.id)) continue;
    const slot = fragments.get(tc.id) ?? { name: "", args: "" };
    if (tc.name) slot.name = tc.name;
    if (typeof tc.args === "string") slot.args += tc.args;
    fragments.set(tc.id, slot);
  }
  for (const [id, slot] of fragments) {
    out.set(id, { id, name: slot.name, args: parseToolArgs(slot.args) });
  }
  return [...out.values()];
}

export function streamWithConfig(
  threadId: string,
  messages: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>,
  options?: StreamOptions,
  signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  // Wrap the entire run in a MaskRunContext (AsyncLocalStorage). The
  // async generator created here, plus all downstream awaits / nested
  // async calls (chat-model invocation, tool execution), inherit the
  // store from the async-resource context active at construction time.
  // No-op when redaction is disabled (per ADR-0064).
  return withMaskRun(() => streamWithConfigImpl(threadId, messages, options, signal));
}

type RunnableModelConfig = NonNullable<ReturnType<typeof resolveRunnableModelConfig>>;
type AgentRunConfig = StreamOptions["agent_run_config"];

interface InferenceBudget {
  delegationBudget: DelegationBudget | null;
  activeInference: {
    current: {
      reservation: DelegationCostReservation;
      rates: ProviderRates;
      usage: InferenceUsage;
    } | null;
  };
  settleInferenceReservation: (retainFullReservation?: boolean) => void;
  preModelHook: () => { messages?: HumanMessage[] };
}

async function prepareInference(
  threadId: string,
  cfg: RunnableModelConfig,
  options?: StreamOptions,
) {
  const runCfg = options?.agent_run_config;

  const baseParams: ProviderParams = getModelParams(cfg);
  // If the model config doesn't set max_tokens explicitly, use the budget-
  // derived output reserve forwarded from run-thread. This avoids both
  // under-provisioning (4096 default on long complex turns) and
  // over-provisioning (4096 default on simple turns where the output budget
  // is smaller than 4096). The provider still falls back to 4096 when neither
  // is present.
  const strategyOutputCap = runCfg?.max_output_tokens;
  const outputLimit = strategyOutputCap !== undefined
    ? Math.min(baseParams.max_tokens ?? strategyOutputCap, strategyOutputCap)
    : runCfg?.output_reserve_tokens && !baseParams.max_tokens
      ? runCfg.output_reserve_tokens
      : undefined;
  const params: ProviderParams = {
    ...baseParams,
    ...(runCfg?.thinking_params ?? {}),
    ...(outputLimit !== undefined ? { max_tokens: outputLimit } : {}),
  };

  const provider = getProvider(cfg.provider);
  const includeImages = modelCapabilities(cfg.provider, cfg.model_id).vision;

  const toolPolicy = runCfg?.allowed_tools?.length
    ? { allow: runCfg.allowed_tools }
    : options?.tool_policy;
  // Two wrapping layers — order matters. Credential-routing must run on
  // the OUTSIDE so it sees the original `invoke` and can establish the
  // AsyncLocalStorage frame before the rehydrate proxy delegates. Both
  // layers are no-ops when their respective context (mask run / override
  // map) is empty.
  const baseTools = await getAllToolsAsync(toolPolicy);
  const rehydrated = wrapToolsForRehydrate(baseTools);
  const tools = wrapToolsForCredentialRouting(rehydrated, runCfg?.tool_credentials ?? {});

  const isDelegatedRun = (runCfg?.delegation?.depth ?? 0) > 0;
  const model = new JarelaChatModel({
    provider,
    modelId: cfg.model_id,
    params,
    maxRetries: isDelegatedRun ? 0 : undefined,
  });
  const store = new SqliteMemoryStore();
  const checkpointer = getCheckpointer();

  // Wipe prior checkpoint state for this thread BEFORE invoking the agent.
  // Every turn we rebuild the message history from jarela.db.messages (the
  // source of truth), so the checkpointer's only job is to buffer in-flight
  // tool-call state within the current turn. Without this delete, LangGraph's
  // default messages-state reducer keeps appending — every prior turn's tool
  // results stay in state forever and get replayed to the LLM, eventually
  // blowing past the model's context window.
  //
  // ADR-0065 image refs and ADR-0079 tool-result refs shrink persisted
  // payloads, but the delete still bounds LangGraph's in-flight reducer.
  try {
    await checkpointer.deleteThread(threadId);
  } catch (err) {
    // SqliteSaver creates the `checkpoints` table lazily on first write.
    // If we get here before any checkpoint has ever been persisted (fresh
    // DB, first turn of the process), deleteThread raises
    // `SQLITE_ERROR: no such table: checkpoints` — which is a no-op for us,
    // not an error. Swallow it; surface anything else.
    const msg = errorMessage(err);
    if (!/no such table:\s*checkpoints/i.test(msg)) {
      console.error("[llm] checkpoint reset failed for thread", threadId, err);
    }
  }

  return { baseParams, strategyOutputCap, params, includeImages, tools, isDelegatedRun, model, store, checkpointer };
}

function createInferenceBudget(
  threadId: string,
  cfg: RunnableModelConfig,
  params: ProviderParams,
  runCfg: AgentRunConfig,
  signal: AbortSignal | undefined,
  isDelegatedRun: boolean,
): InferenceBudget {
  const delegationBudget = isDelegatedRun
    && isDelegationBudget(runCfg?.delegation_budget)
    ? runCfg.delegation_budget
    : null;
  const activeInference: InferenceBudget["activeInference"] = { current: null };
  const settleInferenceReservation = (retainFullReservation = false): void => {
    if (!delegationBudget || !activeInference.current) return;
    const active = activeInference.current;
    activeInference.current = null;
    const hasUsage = !retainFullReservation
      && (active.usage.inputTokens > 0 || active.usage.outputTokens > 0);
    const actualCost = hasUsage
      ? estimateProviderCostUsd(cfg.provider, active.usage.inputTokens, active.usage.outputTokens, active.rates, {
          cache_creation_input_tokens: active.usage.cacheCreationTokens,
          cache_read_input_tokens: active.usage.cacheReadTokens,
        })
      : null;
    const settled = settleDelegationCost(
      active.reservation,
      actualCost !== null && Number.isFinite(actualCost) && actualCost >= 0 ? actualCost : null,
    );
    if (settled.overrun) {
      throw new DelegationCostBudgetError(
        "Provider-reported usage exceeded the reserved per-inference delegation cost; further inference is blocked.",
      );
    }
  };

  // Runs before every model call inside the react loop. Reserve against the
  // shared root budget before contacting the provider, then settle the prior
  // inference from its usage before a later request can start.
  const preModelHook = () => {
    if (delegationBudget) {
      if (signal?.aborted) {
        const aborted = new Error("Delegated inference cancelled before provider invocation.");
        aborted.name = "AbortError";
        throw aborted;
      }
      settleInferenceReservation();
      const contextWindowCaps = [
        runCfg?.context_window_tokens,
        params.context_window_tokens,
        getKnownContextLength(cfg.provider, cfg.model_id),
      ].filter((value): value is number =>
        typeof value === "number" && Number.isSafeInteger(value) && value > 0);
      const contextWindowTokens = contextWindowCaps.length > 0
        ? Math.min(...contextWindowCaps)
        : undefined;
      const outputTokens = params.max_tokens ?? runCfg?.max_output_tokens;
      if (
        !contextWindowTokens || !Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0
        || !outputTokens || !Number.isSafeInteger(outputTokens) || outputTokens <= 0
      ) {
        throw new DelegationCostBudgetError(
          "Delegated inference refused because its context or output token ceiling is unknown.",
        );
      }
      const rates = modelRatesFor(getPricingTables(), cfg.provider, cfg.model_id);
      if (!isKnownCanonicalRate(rates)) {
        throw new DelegationCostBudgetError(
          `Delegated inference refused because canonical pricing is unavailable for ${cfg.provider}/${cfg.model_id}.`,
        );
      }
      const maximumCostUsd = maxInferenceCostUsd(rates, contextWindowTokens, outputTokens);
      const reserved = reserveDelegationCost(delegationBudget, maximumCostUsd);
      if (!reserved.ok) {
        throw new DelegationCostBudgetError(
          reserved.reason === "cost_exhausted"
            ? "The root delegation cost budget cannot reserve another bounded model inference."
            : "Delegated inference refused because its cost reservation could not be verified.",
        );
      }
      activeInference.current = {
        reservation: reserved.reservation,
        rates,
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      };
    }
    const steering = drainSteering(threadId);
    if (steering.length === 0) return {};
    return { messages: steering.map((text) => new HumanMessage(text)) };
  };
  return { delegationBudget, activeInference, settleInferenceReservation, preModelHook };
}

class InferenceStreamProjection {
  private readonly announcedToolIds = new Set<string>();
  private pendingAIChunk: AIMessageChunk | null = null;
  private totalOutputTokens = 0;
  private usageInputTokens = 0;
  private usageOutputTokens = 0;
  private usageCacheCreationTokens = 0;
  private usageCacheReadTokens = 0;
  private usageThinkingTokens = 0;
  private sawUsage = false;
  private needsParagraphBreak = false;
  private textEmittedSinceLastBreak = false;
  readonly textRehydrator: StreamRehydrator | null;
  truncatedByLength = false;

  constructor(
    private readonly activeInference: InferenceBudget["activeInference"],
    private readonly delegationBudget: DelegationBudget | null,
  ) {
    const maskRun = getMaskRunContext();
    this.textRehydrator = maskRun ? new StreamRehydrator(maskRun.ctx) : null;
  }

  private recordUsage(chunk: AIMessageChunk): void {
    const usage = chunk.usage_metadata;
    if (!usage || !(usage.input_tokens > 0 || usage.output_tokens > 0)) return;
    this.usageInputTokens += usage.input_tokens ?? 0;
    this.usageOutputTokens += usage.output_tokens ?? 0;
    const details = usage.input_token_details;
    this.usageCacheCreationTokens += details?.cache_creation ?? 0;
    this.usageCacheReadTokens += details?.cache_read ?? 0;
    this.usageThinkingTokens += usage.output_token_details?.reasoning ?? 0;
    if (this.delegationBudget && this.activeInference.current) {
      const active = this.activeInference.current.usage;
      active.inputTokens += usage.input_tokens ?? 0;
      active.outputTokens += usage.output_tokens ?? 0;
      active.cacheCreationTokens += details?.cache_creation ?? 0;
      active.cacheReadTokens += details?.cache_read ?? 0;
    }
    this.sawUsage = true;
  }

  private *projectAIChunk(chunk: AIMessageChunk): Iterable<StreamChunk> {
    this.recordUsage(chunk);
    let emittedVisibleChunk = false;
    if (typeof chunk.content === "string" && chunk.content) {
      let delta = this.textRehydrator ? this.textRehydrator.push(chunk.content) : chunk.content;
      if (delta) {
        if (this.needsParagraphBreak && this.textEmittedSinceLastBreak) {
          delta = "\n\n" + delta;
        }
        this.needsParagraphBreak = false;
        this.textEmittedSinceLastBreak = true;
        this.totalOutputTokens += 1;
        yield { type: "text_delta", data: { delta } };
        emittedVisibleChunk = true;
      }
    }
    const reasoning = chunk.additional_kwargs?.reasoning_content;
    if (typeof reasoning === "string" && reasoning) {
      yield { type: "thinking_delta", data: { delta: reasoning } };
      emittedVisibleChunk = true;
    }
    if (chunk.additional_kwargs?.stop_reason === "length") this.truncatedByLength = true;
    this.pendingAIChunk = this.pendingAIChunk ? this.pendingAIChunk.concat(chunk) : chunk;
    // Tool argument fragments and held secret placeholders still advance the watchdog.
    if (!emittedVisibleChunk) yield { type: "heartbeat", data: {} };
  }

  *flushPendingToolCalls(): Iterable<StreamChunk> {
    if (!this.pendingAIChunk) return;
    for (const tc of collectToolCalls(this.pendingAIChunk)) {
      if (this.announcedToolIds.has(tc.id)) continue;
      this.announcedToolIds.add(tc.id);
      yield { type: "tool_call", data: { id: tc.id, name: tc.name, arguments: tc.args } };
    }
    this.pendingAIChunk = null;
  }

  *project(mode: string, payload: unknown): Iterable<StreamChunk> {
    if (mode === "messages") {
      const [chunk] = payload as [BaseMessage, unknown];
      if (chunk instanceof AIMessageChunk) {
        yield* this.projectAIChunk(chunk);
      } else if (chunk instanceof ToolMessage) {
        yield* this.flushPendingToolCalls();
        let result: unknown = chunk.content;
        if (typeof result === "string") {
          try { result = JSON.parse(result); } catch { /* keep string */ }
        }
        yield {
          type: "tool_result",
          data: { id: chunk.tool_call_id, name: chunk.name ?? "", result, status: chunk.status },
        };
        this.needsParagraphBreak = true;
      }
    } else if (mode === "updates") {
      yield* this.flushPendingToolCalls();
    } else if (mode === "custom") {
      const c = payload as { id?: string; name?: string; text?: string };
      if (c && typeof c.text === "string" && c.text) {
        yield { type: "tool_progress", data: { id: c.id ?? "", name: c.name ?? "", text: c.text } };
      }
    }
  }

  done(threadId: string, cfg: RunnableModelConfig, runCfg: AgentRunConfig, aborted = false): StreamChunk {
    return {
      type: "done",
      data: {
        message_id: `llm-${threadId}-${Date.now()}`,
        usage: this.sawUsage
          ? {
              input_tokens: this.usageInputTokens,
              output_tokens: this.usageOutputTokens,
              cache_creation_input_tokens: this.usageCacheCreationTokens,
              cache_read_input_tokens: this.usageCacheReadTokens,
              thinking_tokens: this.usageThinkingTokens || undefined,
              source: "provider",
            }
          : { input_tokens: 0, output_tokens: this.totalOutputTokens, source: "estimate" },
        provider: cfg.provider,
        model_id: cfg.model_id,
        model_config_name: cfg.name,
        route_decision: runCfg?.route_decision ?? null,
        ...(aborted ? { aborted: true } : {}),
      },
    };
  }
}

async function* streamWithConfigImpl(
  threadId: string,
  messages: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>,
  options?: StreamOptions,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const runCfg = options?.agent_run_config;
  const cfg = resolveRunnableModelConfig(runCfg?.model_config_name ?? null);
  if (!cfg) {
    yield { type: "error", data: { message: "No model configured. Add a model in the Models panel.", code: "no_model" } };
    return;
  }
  const { baseParams, strategyOutputCap, params, includeImages, tools, isDelegatedRun,
    model, store, checkpointer } = await prepareInference(threadId, cfg, options);
  const { delegationBudget, activeInference, settleInferenceReservation, preModelHook } =
    createInferenceBudget(threadId, cfg, params, runCfg, signal, isDelegatedRun);
  const agent = createReactAgent({ llm: model, tools, store, checkpointer, preModelHook });

  const projection = new InferenceStreamProjection(activeInference, delegationBudget);

  try {
    const agentStream = await agent.stream(
      { messages: await toBaseMessages(messages, runCfg?.system_prompt, { includeImages }) },
      {
        streamMode: ["messages", "updates", "custom"],
        configurable: {
          thread_id: threadId,
          signal_continuation: runCfg?.signal_continuation === true,
          delegation_depth: runCfg?.delegation?.depth ?? 0,
          delegation_ancestors: runCfg?.delegation?.ancestors ?? [],
          delegation_budget: runCfg?.delegation_budget,
          tool_permission_map: runCfg?.tool_permission_map,
        },
        // LangGraph counts EACH node visit (model call + each tool call) as a
        // step. File-organization, multi-search-and-fetch, and any task that
        // pairs every action with a verify call (file_move + file_stat, etc.)
        // burns through 50 fast — 25 file moves and you're done. 200 leaves
        // generous headroom for legitimate multi-step work while still
        // bounding obvious runaway loops. Configurable via env per deployment.
        recursionLimit: getConfig().recursionLimit,
        // Cancellation: when the user hits Stop (or the last client
        // disconnects), the route aborts this signal and the LangGraph
        // pregel loop unwinds, throwing a friendly aborted error below.
        signal,
      },
    );

    for await (const [mode, payload] of agentStream as AsyncIterable<[string, unknown]>) {
      yield* projection.project(mode, payload);
    }

    settleInferenceReservation();
    // Final flush in case stream ended without an "updates" tick.
    yield* projection.flushPendingToolCalls();
    // Flush any text the rehydrator was still holding (an unclosed
    // placeholder — emitted as-is rather than silently dropped).
    if (projection.textRehydrator) {
      const trailing = projection.textRehydrator.flush();
      if (trailing) {
        yield { type: "text_delta", data: { delta: trailing } };
      }
    }
  } catch (err) {
    let caughtError = err;
    try {
      settleInferenceReservation(true);
    } catch (settlementError) {
      caughtError = settlementError;
    }
    yield* inferenceFailure(err, caughtError, cfg, baseParams, signal, projection, threadId, runCfg);
    return;
  }
  yield* completeInference(projection, cfg, params, strategyOutputCap, threadId, runCfg);
}

function* inferenceFailure(
  err: unknown,
  caughtError: unknown,
  cfg: RunnableModelConfig,
  baseParams: ProviderParams,
  signal: AbortSignal | undefined,
  projection: InferenceStreamProjection,
  threadId: string,
  runCfg: AgentRunConfig,
): Iterable<StreamChunk> {
  const name = caughtError instanceof Error ? caughtError.name : "";
  const baseMsg = errorMessage(caughtError);
  const stack = caughtError instanceof Error && caughtError.stack ? caughtError.stack : "";
  // undici hides actionable network errors under cause; retain the bounded chain.
  const causeChain: string[] = [];
  let cur: unknown = err;
  let depth = 0;
  while (cur && typeof cur === "object" && "cause" in cur && depth < 4) {
    const c = (cur as { cause?: unknown }).cause;
    if (!c) break;
    const cMsg = c instanceof Error ? `${c.name}: ${c.message}` : String(c);
    const cCode = c && typeof c === "object" && "code" in c ? ` [${(c as { code?: string }).code}]` : "";
    causeChain.push(`${cMsg}${cCode}`);
    cur = c;
    depth += 1;
  }
  const rawMsg = causeChain.length > 0
    ? `${baseMsg} (cause: ${causeChain.join(" → ")})`
    : baseMsg;

  // Abort still emits done so queued UI messages can drain normally.
  if (signal?.aborted || name === "AbortError" || /aborted/i.test(rawMsg)) {
    yield { type: "error", data: { message: "Run interrupted by user.", code: "aborted" } };
    yield projection.done(threadId, cfg, runCfg, true);
    return;
  }

  console.error("[agent_error]", stack || rawMsg);
  let friendly = rawMsg;
  let code = "agent_error";
  let errPayloadRetryAfterMs: number | undefined;
  if (
    name === "DelegationCostBudgetError"
    || /delegated inference refused|delegation cost budget|reserved per-inference delegation cost/i.test(rawMsg)
  ) {
    code = "delegation_cost_budget";
  } else if (name === "GraphRecursionError" || /recursion limit/i.test(rawMsg)) {
    const limit = getConfig().recursionLimit;
    friendly =
      `The agent took too many tool-calling steps without finishing (hit the ${limit}-step limit). ` +
      `If the task is legitimately deep, raise JARELA_RECURSION_LIMIT in the env. ` +
      `If the agent looked stuck in a loop (calling the same tool repeatedly), simplify the prompt or ` +
      `try /new to start fresh — long histories of tool results sometimes make the model re-attempt the same step.`;
    code = "recursion_limit";
  } else if (/Received empty response from chat model call/i.test(rawMsg)) {
    friendly =
      "The model returned an empty response. This usually means a content filter triggered, " +
      "max_tokens was too low for a reasoning model, or the connection dropped mid-stream. " +
      "Check the model config and retry.";
    code = "empty_response";
  } else if (isContextOverflowError(rawMsg)) {
    friendly = correctContextWindow(rawMsg, cfg, baseParams);
    code = "context_length_exceeded";
  } else if (err instanceof ProviderAuthError || isAuthErrorMessage(rawMsg)) {
    const providerLabel = err instanceof ProviderAuthError ? err.provider : cfg.provider;
    friendly =
      `${providerLabel}: the credential the model uses was rejected as invalid or expired. ` +
      `Open the credential in Settings → Credentials and re-enter or refresh the key, then retry.`;
    code = "auth_failed";
  } else if (isRetryableProviderStreamError(rawMsg)) {
    friendly =
      `${cfg.provider}: the streaming connection ended before the model produced output. ` +
      "This is usually a temporary network or upstream failure; retrying may recover it.";
    code = "stream_error";
  } else if (isRateLimitError(err, rawMsg)) {
    const retryAfterSec = parseRetryAfterSeconds(err, rawMsg);
    const waitHint = retryAfterSec != null
      ? ` The provider asked us to wait ~${retryAfterSec}s before retrying.`
      : "";
    friendly =
      `${cfg.provider}: rate-limited (HTTP 429). The provider's per-minute/per-day quota for this ` +
      `credential is exhausted.${waitHint} Wait and retry, or switch to a different model / credential ` +
      `in Settings → Models.`;
    code = "rate_limited";
    if (retryAfterSec !== null) errPayloadRetryAfterMs = retryAfterSec * 1000;
    if (retryAfterSec !== null) errPayloadRetryAfterMs = retryAfterSec * 1000;
  } else if (/max_tokens/i.test(rawMsg) && /no content|before hitting/i.test(rawMsg)) {
    code = "max_tokens_exhausted";
  }
  const firstAppFrame = stack.split("\n").find((l) => /\(rsc\)\.\/lib\//.test(l));
  const trimmed = firstAppFrame ? `\n${firstAppFrame.trim()}` : "";
  const errPayload: Record<string, unknown> = { message: `${friendly}${trimmed}`, code };
  if (errPayloadRetryAfterMs !== undefined) errPayload.retry_after_ms = errPayloadRetryAfterMs;
  if (errPayloadRetryAfterMs !== undefined) errPayload.retry_after_ms = errPayloadRetryAfterMs;
  if (code === "auth_failed" && cfg.credential_id) {
    errPayload.credential_id = cfg.credential_id;
    errPayload.provider = cfg.provider;
  }
  yield { type: "error", data: errPayload };
}

function correctContextWindow(rawMsg: string, cfg: RunnableModelConfig, baseParams: ProviderParams): string {
  const observed = parseContextLimitFromError(rawMsg);
  if (observed && observed.limit > 0) {
    // Shrink, never grow, with a margin for tokenizer and tool-result overhead.
    try {
      const current = typeof baseParams.context_window_tokens === "number"
        ? baseParams.context_window_tokens
        : Number.POSITIVE_INFINITY;
      const corrected = Math.max(2048, Math.floor(observed.limit * 0.9));
      if (corrected < current) {
        const nextParams = { ...baseParams, context_window_tokens: corrected };
        upsertModelConfig(cfg.name, cfg.provider, cfg.model_id, nextParams, cfg.is_default === 1);
        console.warn(
          `[llm] context-window self-correct for ${cfg.name} (${cfg.provider}/${cfg.model_id}): ` +
          `provider reported ${observed.limit} tokens; persisted context_window_tokens=${corrected}`,
        );
      }
    } catch (persistErr) {
      console.error("[llm] failed to self-correct context_window_tokens", persistErr);
    }
    return `The request exceeded the model's context window (provider reported ~${observed.limit.toLocaleString()} tokens` +
      (observed.requested ? `, request had ~${observed.requested.toLocaleString()}` : "") +
      `). Persisted the corrected window on this model config; retry the turn or trim history.`;
  }
  // Without a parseable limit, converge by halving the persisted assumption.
  try {
    const current = typeof baseParams.context_window_tokens === "number" && baseParams.context_window_tokens > 0
      ? baseParams.context_window_tokens
      : 128_000;
    const corrected = Math.max(2048, Math.floor(current / 2));
    if (corrected < current) {
      const nextParams = { ...baseParams, context_window_tokens: corrected };
      upsertModelConfig(cfg.name, cfg.provider, cfg.model_id, nextParams, cfg.is_default === 1);
      console.warn(
        `[llm] context-window halve-fallback for ${cfg.name} (${cfg.provider}/${cfg.model_id}): ` +
        `no limit parsed from error; halved ${current} -> ${corrected}`,
      );
    }
  } catch (persistErr) {
    console.error("[llm] failed halve-fallback for context_window_tokens", persistErr);
  }
  return "The request exceeded the model's context window. Halved the model's " +
    "`context_window_tokens` and persisted it — retry the turn. " +
    "If this recurs, trim history (lower `history_limit` / `history_window_hours` on the agent) " +
    "or pin a smaller value explicitly in the model config.";
}

function* completeInference(
  projection: InferenceStreamProjection,
  cfg: RunnableModelConfig,
  params: ProviderParams,
  strategyOutputCap: number | undefined,
  threadId: string,
  runCfg: AgentRunConfig,
): Iterable<StreamChunk> {
  if (projection.truncatedByLength) {
    yield {
      type: "error",
      data: {
        message:
          `Response truncated — ${cfg.model_id} hit its output limit (${params.max_tokens ?? "provider default"} tokens) before finishing. ` +
          (strategyOutputCap !== undefined
            ? "The active usage strategy caps output; switch it to balanced or high_reasoning (JARELA_USAGE_STRATEGY), or raise max_tokens in the model config, and ask me to continue."
            : "Raise max_tokens in the model config and ask me to continue."),
        code: "max_tokens_truncated",
      },
    };
  }

  yield projection.done(threadId, cfg, runCfg);
}

// Detect provider error messages that indicate the request exceeded the
// model's input/context window. Patterns sourced from OpenAI, Anthropic,
// Gemini, DeepSeek, and the Copilot proxy.
export function isContextOverflowError(msg: string): boolean {
  if (!msg) return false;
  return (
    /context[_ ]length[_ ]exceeded/i.test(msg) ||
    /maximum context length/i.test(msg) ||
    /context window/i.test(msg) ||
    /prompt is too long/i.test(msg) ||
    /input(?:'s)? token count.*exceeds/i.test(msg) ||
    /exceeds the maximum number of tokens/i.test(msg) ||
    /request too large.*tokens/i.test(msg) ||
    /too many input tokens/i.test(msg) ||
    /string too long/i.test(msg)
  );
}

// Extract the model's actual context-window size (and, when present, the
// request size) from a provider error message. Provider phrasings observed:
//   OpenAI:     "maximum context length is 128000 tokens. However, your
//                messages resulted in 213998 tokens"
//   OpenAI:     "This model's maximum context length is 8192 tokens, however
//                you requested 9000 tokens"
//   Anthropic:  "prompt is too long: 235812 tokens > 200000 maximum"
//   Gemini:     "The input token count (1234567) exceeds the maximum number
//                of tokens allowed (1048576)"
//   DeepSeek:   "Range of input length should be [1, 65536]"
// Returns null when no number pair can be confidently extracted.
export function parseContextLimitFromError(
  msg: string,
): { limit: number; requested?: number } | null {
  if (!msg) return null;
  const num = (s: string) => parseInt(s.replace(/[,_\s]/g, ""), 10);

  // OpenAI "maximum context length is X tokens" (+ optional "resulted in Y" / "requested Y")
  const openai = msg.match(
    /maximum context length is\s+([\d,_\s]+)\s*tokens?[\s\S]*?(?:resulted in|requested)\s+([\d,_\s]+)/i,
  );
  if (openai) {
    const limit = num(openai[1]);
    const requested = num(openai[2]);
    if (limit > 0) return { limit, requested: requested > 0 ? requested : undefined };
  }
  const openaiNoReq = msg.match(/maximum context length is\s+([\d,_\s]+)/i);
  if (openaiNoReq) {
    const limit = num(openaiNoReq[1]);
    if (limit > 0) return { limit };
  }

  // Anthropic "prompt is too long: N tokens > M maximum"
  const anthropic = msg.match(/prompt is too long:\s*([\d,_\s]+)\s*tokens?\s*>\s*([\d,_\s]+)/i);
  if (anthropic) {
    const requested = num(anthropic[1]);
    const limit = num(anthropic[2]);
    if (limit > 0) return { limit, requested: requested > 0 ? requested : undefined };
  }

  // Gemini "input token count (N) exceeds the maximum number of tokens allowed (M)"
  const gemini = msg.match(/input token count\s*\(([\d,_\s]+)\)[\s\S]*?\(([\d,_\s]+)\)/i);
  if (gemini) {
    const requested = num(gemini[1]);
    const limit = num(gemini[2]);
    if (limit > 0) return { limit, requested: requested > 0 ? requested : undefined };
  }

  // DeepSeek "Range of input length should be [1, N]"
  const deepseek = msg.match(/range of input length should be\s*\[\s*\d+\s*,\s*([\d,_\s]+)\s*\]/i);
  if (deepseek) {
    const limit = num(deepseek[1]);
    if (limit > 0) return { limit };
  }

  return null;
}

// Detect provider throttling. Anthropic / OpenAI SDKs throw an APIError
// with `status === 429` and a message like "429 status code (no body)".
// Context-overflow is checked first upstream, so this only fires for real
// quota / per-minute throttling, not for oversized prompts.
export function isRateLimitError(err: unknown, msg: string): boolean {
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    if (status === 429 || status === "429") return true;
  }
  if (!msg) return false;
  return (
    /\b429\b/.test(msg) ||
    /\brate[_\s-]*limit/i.test(msg) ||
    /\btoo many requests\b/i.test(msg) ||
    /\bquota exceeded\b/i.test(msg)
  );
}

// Extract the `retry-after` hint the provider sent, in seconds. Both the
// Anthropic and OpenAI SDKs expose response headers on the thrown
// APIError as `err.headers` (a plain object with lowercase keys). Some
// providers also embed the value in the error message.
export function parseRetryAfterSeconds(err: unknown, msg: string): number | null {
  if (err && typeof err === "object") {
    const headers = (err as { headers?: unknown }).headers;
    if (headers && typeof headers === "object") {
      const record = headers as Record<string, unknown> & { get?: (name: string) => string | null };
      const rawMs = record["retry-after-ms"] ?? record.get?.("retry-after-ms");
      if (typeof rawMs === "number" && Number.isFinite(rawMs) && rawMs >= 0) return Math.ceil(rawMs / 1000);
      if (typeof rawMs === "string" && rawMs.trim() && Number.isFinite(Number(rawMs)) && Number(rawMs) >= 0) {
        return Math.ceil(Number(rawMs) / 1000);
      }
      const raw = record["retry-after"] ?? record["Retry-After"] ?? record.get?.("retry-after");
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.ceil(raw);
      if (typeof raw === "string") {
        const n = Number(raw);
        if (raw.trim() && Number.isFinite(n) && n >= 0) return Math.ceil(n);
        const dateMs = Date.parse(raw);
        if (Number.isFinite(dateMs)) return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
      }
    }
  }
  if (msg) {
    const m = msg.match(/retry[_\s-]*after[:\s]*(\d+)/i);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}
