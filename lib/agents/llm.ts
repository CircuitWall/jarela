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
import { getModelConfig, getDefaultModelConfig, getModelParams, upsertModelConfig } from "@/lib/stores/model-config";
import { getAllToolsAsync } from "@/lib/tools";
import { JarelaChatModel } from "@/lib/providers/jarela-chat-model";
import { SqliteMemoryStore } from "@/lib/stores/langgraph-store";
import { getCheckpointer } from "@/lib/agents/checkpointer";
import type { ContentPart } from "@/lib/tools/types";
import type { StreamChunk, StreamOptions } from "./base";
import type { ProviderParams } from "@/lib/providers/types";
import { getConfig } from "@/lib/env/config";

function toBaseMessages(
  messages: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>,
  systemPrompt?: string,
): BaseMessage[] {
  const base: BaseMessage[] = systemPrompt ? [new SystemMessage(systemPrompt)] : [];
  return [
    ...base,
    ...messages.map((m) => {
      // Plain text path — fast & most common.
      if (typeof m.content === "string") {
        return m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content);
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
        return new AIMessage(text);
      }
      const blocks: Array<Record<string, unknown>> = [];
      for (const part of m.content) {
        if (part.type === "text") {
          if (part.text) blocks.push({ type: "text", text: part.text });
        } else if (part.type === "image") {
          blocks.push({
            type: "image_url",
            image_url: { url: `data:${part.media_type};base64,${part.data}` },
          });
        } else if (part.type === "file") {
          if (part.media_type.startsWith("text/") || part.media_type === "application/json") {
            blocks.push({ type: "text", text: `[Attached file: ${part.name}]\n${part.data}` });
          } else {
            blocks.push({ type: "text", text: `[Attached file: ${part.name} (${part.media_type})]` });
          }
        }
      }
      // Cast through unknown — LangChain's strict block-union type rejects our
      // dynamic shape, but at runtime BaseMessage stores content as-is and
      // ChatModels consume whatever the provider's API expects (image_url for
      // OpenAI, image for Anthropic, etc.).
      return new HumanMessage({ content: blocks as unknown as string });
    }),
  ];
}

export async function* streamWithConfig(
  threadId: string,
  messages: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>,
  options?: StreamOptions,
  signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  const runCfg = options?.agent_run_config;

  const cfgName = runCfg?.model_config_name ?? null;
  const cfg = cfgName ? getModelConfig(cfgName) : getDefaultModelConfig();

  if (!cfg) {
    yield { type: "error", data: { message: "No model configured. Add a model in the Models panel.", code: "no_model" } };
    return;
  }

  const params: ProviderParams = getModelParams(cfg);

  const provider = getProvider(cfg.provider);

  // Compose the caller's signal with a per-stream wall-clock deadline.
  // recursionLimit caps the number of node visits but not real time — a
  // slow provider or stuck network call would otherwise keep streaming
  // until the registry's 15-min watchdog fires. This is the tighter
  // primary deadline; the registry watchdog stays as the backstop for
  // pathological cases (broadcast() never fires, etc.).
  const llmStreamMaxMs = getConfig().llmStreamMaxMs;
  const deadline = makeStreamDeadline(signal, llmStreamMaxMs);

  const toolPolicy = runCfg?.allowed_tools?.length
    ? { allow: runCfg.allowed_tools }
    : options?.tool_policy;
  const tools = await getAllToolsAsync(toolPolicy);

  const model = new JarelaChatModel({ provider, modelId: cfg.model_id, params });
  const store = new SqliteMemoryStore();
  const checkpointer = getCheckpointer();

  // Wipe prior checkpoint state for this thread BEFORE invoking the agent.
  // Every turn we rebuild the message history from jarela.db.messages (the
  // source of truth), so the checkpointer's only job is to buffer in-flight
  // tool-call state within the current turn. Without this delete, LangGraph's
  // default messages-state reducer keeps appending — every prior turn's tool
  // results (plus any inline image data URIs) stay in state forever and get
  // replayed to the LLM, eventually blowing past the model's context window.
  // See: thread fb35423b grew to 893 MB / 238 checkpoints because a single
  // image-attached HumanMessage (~1.2 MB base64) was replayed on every retry.
  try {
    await checkpointer.deleteThread(threadId);
  } catch (err) {
    // SqliteSaver creates the `checkpoints` table lazily on first write.
    // If we get here before any checkpoint has ever been persisted (fresh
    // DB, first turn of the process), deleteThread raises
    // `SQLITE_ERROR: no such table: checkpoints` — which is a no-op for us,
    // not an error. Swallow it; surface anything else.
    const msg = err instanceof Error ? err.message : String(err);
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
      { messages: toBaseMessages(messages, runCfg?.system_prompt) },
      {
        streamMode: ["messages", "updates"],
        configurable: {
          thread_id: threadId,
          delegation_depth: runCfg?.delegation?.depth ?? 0,
          delegation_ancestors: runCfg?.delegation?.ancestors ?? [],
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
        // The composed signal also carries the per-stream wall-clock
        // deadline (llmStreamMaxMs) so a runaway provider can't pin the
        // turn for the full 15-min registry backstop.
        signal: deadline.signal,
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
            sawUsage = true;
          }
          if (typeof chunk.content === "string" && chunk.content) {
            // After a tool result, the next AI text starts a new conceptual
            // turn. Insert a paragraph break so the pre-tool plan and the
            // post-tool reply don't visually merge into one run-on sentence.
            let delta = chunk.content;
            if (needsParagraphBreak && textEmittedSinceLastBreak) {
              delta = "\n\n" + delta;
            }
            needsParagraphBreak = false;
            textEmittedSinceLastBreak = true;
            totalOutputTokens += 1;
            yield { type: "text_delta", data: { delta } };
          }
          const reasoning = chunk.additional_kwargs?.reasoning_content;
          if (typeof reasoning === "string" && reasoning) {
            yield { type: "thinking_delta", data: { delta: reasoning } };
          }
          if (chunk.additional_kwargs?.stop_reason === "length") {
            truncatedByLength = true;
          }
          pendingAIChunk = pendingAIChunk ? pendingAIChunk.concat(chunk) : chunk;
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
      }
    }

    // Final flush in case stream ended without an "updates" tick.
    yield* flushPendingToolCalls();
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const baseMsg = err instanceof Error ? err.message : String(err);
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

    // User-initiated abort (Stop button / client disconnect) OR per-stream
    // wall-clock deadline. We branch on which one fired so the user sees a
    // useful explanation instead of "Run interrupted" for both.
    if (signal?.aborted || deadline.timedOut || name === "AbortError" || /aborted/i.test(rawMsg)) {
      const message = deadline.timedOut && !signal?.aborted
        ? `Run exceeded the per-stream wall-clock limit (${Math.floor(llmStreamMaxMs / 1000)}s). ` +
          `If your task is legitimately long, raise JARELA_LLM_STREAM_MAX_MS in the env. ` +
          `If a tool or provider stalled, retry or simplify the prompt.`
        : "Run interrupted by user.";
      const code = deadline.timedOut && !signal?.aborted ? "stream_deadline" : "aborted";
      yield { type: "error", data: { message, code } };
      yield {
        type: "done",
        data: {
          message_id: `llm-${threadId}-${Date.now()}`,
          usage: sawUsage
            ? { input_tokens: usageInputTokens, output_tokens: usageOutputTokens, source: "provider" }
            : { input_tokens: 0, output_tokens: totalOutputTokens, source: "estimate" },
          provider: cfg.provider,
          model_id: cfg.model_id,
          model_config_name: cfg.name,
          aborted: true,
        },
      };
      deadline.clear();
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
        friendly =
          "The request exceeded the model's context window. " +
          "Trim history (lower `history_limit` / `history_window_hours` on the agent), " +
          "pin a smaller `context_window_tokens` in the model config so the budget calculator " +
          "leaves more headroom, or start a new thread.";
      }
      code = "context_length_exceeded";
    } else if (/max_tokens/i.test(rawMsg) && /no content|before hitting/i.test(rawMsg)) {
      code = "max_tokens_exhausted";
    }
    // Pull out the FIRST in-app frame from the stack so the user sees what
    // module triggered it, without dumping the full Pregel/webpack trace.
    const firstAppFrame = stack.split("\n").find((l) => /\(rsc\)\.\/lib\//.test(l));
    const trimmed = firstAppFrame ? `\n${firstAppFrame.trim()}` : "";
    yield { type: "error", data: { message: `${friendly}${trimmed}`, code } };
    deadline.clear();
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
        ? { input_tokens: usageInputTokens, output_tokens: usageOutputTokens, source: "provider" }
        : { input_tokens: 0, output_tokens: totalOutputTokens, source: "estimate" },
      provider: cfg.provider,
      model_id: cfg.model_id,
      model_config_name: cfg.name,
    },
  };
  deadline.clear();
}

interface StreamDeadline {
  signal: AbortSignal;
  /** True after the per-stream wall-clock fired. False on user-initiated abort. */
  readonly timedOut: boolean;
  /** Cancel the deadline timer + drop the upstream-abort listener. */
  clear(): void;
}

// Compose the caller's signal with a per-stream wall-clock budget. Returns
// a signal that fires when EITHER the upstream signal aborts (user/registry
// watchdog) OR the deadline elapses. `timedOut` discriminates the two so
// the friendly error message can name which one fired.
function makeStreamDeadline(upstream: AbortSignal | undefined, maxMs: number): StreamDeadline {
  const ctrl = new AbortController();
  let timedOut = false;
  let cleared = false;

  const onUpstreamAbort = () => {
    if (cleared) return;
    ctrl.abort(upstream?.reason ?? "run_aborted");
  };

  if (upstream) {
    if (upstream.aborted) {
      ctrl.abort(upstream.reason ?? "run_aborted");
    } else {
      upstream.addEventListener("abort", onUpstreamAbort, { once: true });
    }
  }

  let handle: ReturnType<typeof setTimeout> | null = null;
  if (maxMs > 0) {
    handle = setTimeout(() => {
      if (cleared) return;
      timedOut = true;
      ctrl.abort("stream_deadline");
    }, maxMs);
    handle.unref?.();
  }

  return {
    signal: ctrl.signal,
    get timedOut() { return timedOut; },
    clear() {
      if (cleared) return;
      cleared = true;
      if (handle) clearTimeout(handle);
      if (upstream) upstream.removeEventListener("abort", onUpstreamAbort);
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
