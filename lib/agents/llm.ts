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
import { ProviderAuthError, isAuthErrorMessage } from "@/lib/providers/errors";
import { getModelConfig, getDefaultModelConfig, getModelParams, upsertModelConfig } from "@/lib/stores/model-config";
import { getAllToolsAsync } from "@/lib/tools";
import { JarelaChatModel } from "@/lib/providers/jarela-chat-model";
import { SqliteMemoryStore } from "@/lib/stores/langgraph-store";
import { getCheckpointer } from "@/lib/agents/checkpointer";
import { readImageRef } from "@/lib/attachments/spill";
import type { ContentPart } from "@/lib/tools/types";
import type { StreamChunk, StreamOptions } from "./base";
import type { ProviderParams } from "@/lib/providers/types";
import { getConfig } from "@/lib/env/config";
import { withMaskRun, getMaskRunContext } from "@/lib/redaction/context";
import { StreamRehydrator } from "@/lib/redaction/stream-rehydrate";
import { wrapToolsForRehydrate } from "@/lib/redaction/wrap-tools";
import { wrapToolsForCredentialRouting } from "@/lib/tools/wrap-credentials";
import { errorMessage } from "@/lib/utils/error";
import { modelCapabilities } from "@/lib/providers/capabilities";

export async function toBaseMessages(
  messages: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>,
  systemPrompt?: string,
  options?: { includeImages?: boolean },
): Promise<BaseMessage[]> {
  const base: BaseMessage[] = systemPrompt ? [new SystemMessage(systemPrompt)] : [];
  const out: BaseMessage[] = [...base];
  for (const m of messages) {
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
        blocks.push({ type: "text", text: `[Attached file: ${part.filename} (${part.media_type})]` });
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

async function* streamWithConfigImpl(
  threadId: string,
  messages: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>,
  options?: StreamOptions,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const runCfg = options?.agent_run_config;

  const cfgName = runCfg?.model_config_name ?? null;
  const cfg = (cfgName ? getModelConfig(cfgName) : null) ?? getDefaultModelConfig();

  if (!cfg) {
    yield { type: "error", data: { message: "No model configured. Add a model in the Models panel.", code: "no_model" } };
    return;
  }

  const baseParams: ProviderParams = getModelParams(cfg);
  // If the model config doesn't set max_tokens explicitly, use the budget-
  // derived output reserve forwarded from run-thread. This avoids both
  // under-provisioning (4096 default on long complex turns) and
  // over-provisioning (4096 default on simple turns where the output budget
  // is smaller than 4096). The provider still falls back to 4096 when neither
  // is present.
  const params: ProviderParams =
    runCfg?.output_reserve_tokens && !baseParams.max_tokens
      ? { ...baseParams, max_tokens: runCfg.output_reserve_tokens }
      : baseParams;

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

  const model = new JarelaChatModel({ provider, modelId: cfg.model_id, params });
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

  const agent = createReactAgent({ llm: model, tools, store, checkpointer });

  // Track which AIMessageChunk-tool-call-chunks we've already announced (by id).
  // We emit a tool_call event once per id when both id+name are known and
  // the assistant turn ends, so callers see structured tool calls (not partial ones).
  const announcedToolIds = new Set<string>();
  let pendingAIChunk: AIMessageChunk | null = null;
  let totalOutputTokens = 0;
  // ADR-0041: accumulate real per-call provider usage across the react loop
  // so the `done` chunk can carry authoritative token counts for snapshot.
  // Each LLM call inside the multi-step loop yields its own usage chunk via
  // JarelaChatModel; we sum them so the final figure covers the whole turn.
  let usageInputTokens = 0;
  let usageOutputTokens = 0;
  // PR #181 + cache-fidelity follow-up: Anthropic prompt-cache reads/writes
  // arrive as a separate breakdown via `input_token_details`. Sum them
  // independently so the dashboard can report cost correctly (cache reads
  // are 10× cheaper, cache writes 1.25× more expensive than fresh input).
  let usageCacheCreationTokens = 0;
  let usageCacheReadTokens = 0;
  let usageThinkingTokens = 0;
  let sawUsage = false;
  // Tracks whether the model hit max_tokens mid-stream. JarelaChatModel tags
  // the final chunk with additional_kwargs.stop_reason="length" when this
  // happens; we surface a non-fatal warning before `done` so the user knows
  // their (visibly truncated) response was cut off — and can ask to continue.
  let truncatedByLength = false;
  // Tracks whether the previous emitted chunk was a tool result. When the next
  // AI message starts producing text, we prepend a paragraph break so the
  // pre-tool plan acknowledgment and the post-tool reply don't visually merge.
  let needsParagraphBreak = false;
  let textEmittedSinceLastBreak = false;
  // Stream-aware rehydrator: replaces «SECRET:<id> type=<hint>»
  // placeholders the model echoes back with the original values. Holds
  // partial placeholders across deltas to avoid leaking a half-token to
  // the UI. Bound to the current MaskRunContext; no-op outside one.
  const maskRun = getMaskRunContext();
  const textRehydrator = maskRun ? new StreamRehydrator(maskRun.ctx) : null;

  const flushPendingToolCalls = function* (): Iterable<StreamChunk> {
    if (!pendingAIChunk) return;
    const calls = pendingAIChunk.tool_calls ?? [];
    for (const tc of calls) {
      if (!tc.id || announcedToolIds.has(tc.id)) continue;
      announcedToolIds.add(tc.id);
      yield { type: "tool_call", data: { id: tc.id, name: tc.name ?? "", arguments: tc.args ?? {} } };
    }
    pendingAIChunk = null;
  };

  try {
    const agentStream = await agent.stream(
      { messages: await toBaseMessages(messages, runCfg?.system_prompt, { includeImages }) },
      {
        streamMode: ["messages", "updates", "custom"],
        configurable: {
          thread_id: threadId,
          delegation_depth: runCfg?.delegation?.depth ?? 0,
          delegation_ancestors: runCfg?.delegation?.ancestors ?? [],
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
      if (mode === "messages") {
        const [chunk] = payload as [BaseMessage, unknown];
        if (chunk instanceof AIMessageChunk) {
          // ADR-0041: capture provider-reported token usage when present.
          const usage = chunk.usage_metadata;
          if (usage && (usage.input_tokens > 0 || usage.output_tokens > 0)) {
            usageInputTokens += usage.input_tokens ?? 0;
            usageOutputTokens += usage.output_tokens ?? 0;
            const details = usage.input_token_details;
            if (details) {
              usageCacheCreationTokens += details.cache_creation ?? 0;
              usageCacheReadTokens += details.cache_read ?? 0;
            }
            const outDetails = usage.output_token_details;
            if (outDetails) {
              usageThinkingTokens += outDetails.reasoning ?? 0;
            }
            sawUsage = true;
          }
          let emittedVisibleChunk = false;
          if (typeof chunk.content === "string" && chunk.content) {
            // After a tool result, the next AI text starts a new conceptual
            // turn. Insert a paragraph break so the pre-tool plan and the
            // post-tool reply don't visually merge into one run-on sentence.
            let delta = textRehydrator ? textRehydrator.push(chunk.content) : chunk.content;
            if (delta) {
              if (needsParagraphBreak && textEmittedSinceLastBreak) {
                delta = "\n\n" + delta;
              }
              needsParagraphBreak = false;
              textEmittedSinceLastBreak = true;
              totalOutputTokens += 1;
              yield { type: "text_delta", data: { delta } };
              emittedVisibleChunk = true;
            } else if (textRehydrator) {
              // Held back as part of an unfinished placeholder — keep the
              // run alive so the watchdog doesn't fire while we wait for
              // the close character.
              emittedVisibleChunk = false;
            }
          }
          const reasoning = chunk.additional_kwargs?.reasoning_content;
          if (typeof reasoning === "string" && reasoning) {
            yield { type: "thinking_delta", data: { delta: reasoning } };
            emittedVisibleChunk = true;
          }
          if (chunk.additional_kwargs?.stop_reason === "length") {
            truncatedByLength = true;
          }
          pendingAIChunk = pendingAIChunk ? pendingAIChunk.concat(chunk) : chunk;
          // Silent provider progress (most often partial tool-call args
          // streaming — e.g. the model is mid-way through emitting a
          // large file_write body and each chunk carries only an
          // argument delta, no content). Without a heartbeat the idle
          // watchdog at JARELA_RUN_IDLE_MS (default 120s) would kill
          // the run despite steady forward progress. Heartbeats are
          // dropped by broadcast() after bumping last_chunk_at — they
          // never reach subscribers or the SSE wire.
          if (!emittedVisibleChunk) {
            yield { type: "heartbeat", data: {} };
          }
        } else if (chunk instanceof ToolMessage) {
          yield* flushPendingToolCalls();
          let result: unknown = chunk.content;
          if (typeof result === "string") {
            try { result = JSON.parse(result); } catch { /* keep string */ }
          }
          yield {
            type: "tool_result",
            data: { id: chunk.tool_call_id, name: chunk.name ?? "", result },
          };
          // Next AI text should be visually separated from the pre-tool prose.
          needsParagraphBreak = true;
        }
      } else if (mode === "updates") {
        // End of an agent step — flush any unflushed tool calls (e.g. final assistant message
        // with no follow-up tool execution).
        yield* flushPendingToolCalls();
      } else if (mode === "custom") {
        // Emitted by a tool via config.writer() (see reportToolProgress in
        // lib/tools/workspace-context.ts) — incremental status from inside a
        // still-running tool call, e.g. claude_delegate relaying the
        // sub-agent's own turns. See ADR-0073.
        const c = payload as { id?: string; name?: string; text?: string };
        if (c && typeof c.text === "string" && c.text) {
          yield { type: "tool_progress", data: { id: c.id ?? "", name: c.name ?? "", text: c.text } };
        }
      }
    }

    // Final flush in case stream ended without an "updates" tick.
    yield* flushPendingToolCalls();
    // Flush any text the rehydrator was still holding (an unclosed
    // placeholder — emitted as-is rather than silently dropped).
    if (textRehydrator) {
      const trailing = textRehydrator.flush();
      if (trailing) {
        yield { type: "text_delta", data: { delta: trailing } };
      }
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const baseMsg = errorMessage(err);
    const stack = err instanceof Error && err.stack ? err.stack : "";
    // undici surfaces network failures as a bare "fetch failed" with the
    // real reason (ECONNREFUSED, EAI_AGAIN, UND_ERR_SOCKET, cert issues,
    // proxy CONNECT rejects, …) hidden under err.cause. Walk the chain so
    // operators get a useful log line and the UI shows something actionable.
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

    // User-initiated abort (Stop button / client disconnect): emit a
    // short error chunk and let the route fall through to `done` so the
    // queued-message drain in the UI fires normally.
    if (signal?.aborted || name === "AbortError" || /aborted/i.test(rawMsg)) {
      yield { type: "error", data: { message: "Run interrupted by user.", code: "aborted" } };
      yield {
        type: "done",
        data: {
          message_id: `llm-${threadId}-${Date.now()}`,
          usage: sawUsage
            ? {
                input_tokens: usageInputTokens,
                output_tokens: usageOutputTokens,
                cache_creation_input_tokens: usageCacheCreationTokens,
                cache_read_input_tokens: usageCacheReadTokens,
                thinking_tokens: usageThinkingTokens || undefined,
                source: "provider",
              }
            : { input_tokens: 0, output_tokens: totalOutputTokens, source: "estimate" },
          provider: cfg.provider,
          model_id: cfg.model_id,
          model_config_name: cfg.name,
          route_decision: runCfg?.route_decision ?? null,
          aborted: true,
        },
      };
      return;
    }

    console.error("[agent_error]", stack || rawMsg);

    // Translate LangGraph's recursion limit into a friendly explanation —
    // the raw stack mentions internal Pregel paths users can't act on. They
    // CAN act on knowing the agent loop didn't converge (likely chasing tool
    // results in a loop or a genuinely deep multi-step task).
    let friendly = rawMsg;
    let code = "agent_error";
    if (name === "GraphRecursionError" || /recursion limit/i.test(rawMsg)) {
      const limit = getConfig().recursionLimit;
      friendly =
        `The agent took too many tool-calling steps without finishing (hit the ${limit}-step limit). ` +
        `If the task is legitimately deep, raise JARELA_RECURSION_LIMIT in the env. ` +
        `If the agent looked stuck in a loop (calling the same tool repeatedly), simplify the prompt or ` +
        `try /new to start fresh — long histories of tool results sometimes make the model re-attempt the same step.`;
      code = "recursion_limit";
    } else if (/Received empty response from chat model call/i.test(rawMsg)) {
      // Defense in depth: JarelaChatModel._streamFromProvider already guards
      // against this by emitting a sentinel empty chunk, but if a future
      // provider bypasses that path we still want a useful message instead of
      // the raw LangChain stack.
      friendly =
        "The model returned an empty response. This usually means a content filter triggered, " +
        "max_tokens was too low for a reasoning model, or the connection dropped mid-stream. " +
        "Check the model config and retry.";
      code = "empty_response";
    } else if (isContextOverflowError(rawMsg)) {
      // Hit the model's input window. Either the assumed/known context size
      // is bigger than what the provider actually serves on this tier, the
      // user's plan is throttled, or the conversation legitimately overflowed.
      // Either way the budget calculator's assumption was optimistic — tell
      // the user how to recover instead of dumping the provider stack.
      const observed = parseContextLimitFromError(rawMsg);
      if (observed && observed.limit > 0) {
        // Self-correct: persist the provider-reported limit back to the
        // model config so the next turn's budget calculator uses it. We
        // shrink by 10% as a safety margin (tokenisers disagree and tool
        // results we don't yet count add overhead). Only writes when the
        // new value is smaller than what's stored — never grows blindly.
        try {
          const current = typeof params.context_window_tokens === "number"
            ? params.context_window_tokens
            : Number.POSITIVE_INFINITY;
          const corrected = Math.max(2048, Math.floor(observed.limit * 0.9));
          if (corrected < current) {
            const nextParams = { ...params, context_window_tokens: corrected };
            upsertModelConfig(cfg.name, cfg.provider, cfg.model_id, nextParams, cfg.is_default === 1);
            console.warn(
              `[llm] context-window self-correct for ${cfg.name} (${cfg.provider}/${cfg.model_id}): ` +
              `provider reported ${observed.limit} tokens; persisted context_window_tokens=${corrected}`,
            );
          }
        } catch (persistErr) {
          console.error("[llm] failed to self-correct context_window_tokens", persistErr);
        }
        friendly =
          `The request exceeded the model's context window (provider reported ~${observed.limit.toLocaleString()} tokens` +
          (observed.requested ? `, request had ~${observed.requested.toLocaleString()}` : "") +
          `). Persisted the corrected window on this model config; retry the turn or trim history.`;
      } else {
        // No parseable limit in the error string. Halve the currently
        // persisted `context_window_tokens` (or halve a safe assumption
        // when nothing is pinned) and store it back. The next turn will
        // use the smaller value; if it still overflows we halve again.
        // Convergence takes at most log2(assumed / 2048) turns.
        try {
          const current = typeof params.context_window_tokens === "number" && params.context_window_tokens > 0
            ? params.context_window_tokens
            : 128_000; // Assume mid-size window when nothing is pinned.
          const corrected = Math.max(2048, Math.floor(current / 2));
          if (corrected < current) {
            const nextParams = { ...params, context_window_tokens: corrected };
            upsertModelConfig(cfg.name, cfg.provider, cfg.model_id, nextParams, cfg.is_default === 1);
            console.warn(
              `[llm] context-window halve-fallback for ${cfg.name} (${cfg.provider}/${cfg.model_id}): ` +
              `no limit parsed from error; halved ${current} -> ${corrected}`,
            );
          }
        } catch (persistErr) {
          console.error("[llm] failed halve-fallback for context_window_tokens", persistErr);
        }
        friendly =
          "The request exceeded the model's context window. Halved the model's " +
          "`context_window_tokens` and persisted it — retry the turn. " +
          "If this recurs, trim history (lower `history_limit` / `history_window_hours` on the agent) " +
          "or pin a smaller value explicitly in the model config.";
      }
      code = "context_length_exceeded";
    } else if (err instanceof ProviderAuthError || isAuthErrorMessage(rawMsg)) {
      // Auth failure: the credential is wrong / revoked / expired.
      // Surface a targeted banner in the UI that deep-links to the
      // credential editor. Carry the credential_id in the SSE payload
      // so the UI can pre-open the right row. See ADR-0068.
      const providerLabel = err instanceof ProviderAuthError
        ? err.provider
        : cfg.provider;
      friendly =
        `${providerLabel}: the credential the model uses was rejected as invalid or expired. ` +
        `Open the credential in Settings → Credentials and re-enter or refresh the key, then retry.`;
      code = "auth_failed";
    } else if (isRateLimitError(err, rawMsg)) {
      // Provider throttled us. The raw SDK message is often useless
      // ("429 status code (no body)"), so replace it with something the
      // user can act on. Read `retry-after` from the SDK exception when
      // present so we can tell them how long to wait.
      const retryAfterSec = parseRetryAfterSeconds(err, rawMsg);
      const waitHint = retryAfterSec != null
        ? ` The provider asked us to wait ~${retryAfterSec}s before retrying.`
        : "";
      friendly =
        `${cfg.provider}: rate-limited (HTTP 429). The provider's per-minute/per-day quota for this ` +
        `credential is exhausted.${waitHint} Wait and retry, or switch to a different model / credential ` +
        `in Settings → Models.`;
      code = "rate_limited";
    } else if (/max_tokens/i.test(rawMsg) && /no content|before hitting/i.test(rawMsg)) {
      code = "max_tokens_exhausted";
    }
    // Pull out the FIRST in-app frame from the stack so the user sees what
    // module triggered it, without dumping the full Pregel/webpack trace.
    const firstAppFrame = stack.split("\n").find((l) => /\(rsc\)\.\/lib\//.test(l));
    const trimmed = firstAppFrame ? `\n${firstAppFrame.trim()}` : "";
    const errPayload: Record<string, unknown> = { message: `${friendly}${trimmed}`, code };
    if (code === "auth_failed" && cfg.credential_id) {
      errPayload.credential_id = cfg.credential_id;
      errPayload.provider = cfg.provider;
    }
    yield { type: "error", data: errPayload };
    return;
  }

  if (truncatedByLength) {
    yield {
      type: "error",
      data: {
        message:
          "Response truncated — the model hit its max_tokens limit before finishing. " +
          "Raise max_tokens in the model config (Anthropic defaults to 4096) and ask me to continue.",
        code: "max_tokens_truncated",
      },
    };
  }

  yield {
    type: "done",
    data: {
      message_id: `llm-${threadId}-${Date.now()}`,
      usage: sawUsage
        ? {
            input_tokens: usageInputTokens,
            output_tokens: usageOutputTokens,
            cache_creation_input_tokens: usageCacheCreationTokens,
            cache_read_input_tokens: usageCacheReadTokens,
            thinking_tokens: usageThinkingTokens || undefined,
            source: "provider",
          }
        : { input_tokens: 0, output_tokens: totalOutputTokens, source: "estimate" },
      provider: cfg.provider,
      model_id: cfg.model_id,
      model_config_name: cfg.name,
      route_decision: runCfg?.route_decision ?? null,
    },
  };
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
      const raw = (headers as Record<string, unknown>)["retry-after"]
        ?? (headers as Record<string, unknown>)["Retry-After"];
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.ceil(raw);
      if (typeof raw === "string") {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return Math.ceil(n);
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
