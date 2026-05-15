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
import { getModelConfig, getDefaultModelConfig } from "@/lib/stores/model-config";
import { getAllToolsAsync } from "@/lib/tools";
import { LangGuiChatModel } from "@/lib/providers/langgui-chat-model";
import { SqliteMemoryStore } from "@/lib/stores/langgraph-store";
import { getCheckpointer } from "@/lib/agents/checkpointer";
import type { ContentPart } from "@/lib/tools/types";
import type { StreamChunk, StreamOptions } from "./base";
import type { ProviderParams } from "@/lib/providers/types";

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

  let params: ProviderParams;
  try {
    params = JSON.parse(cfg.params) as ProviderParams;
  } catch {
    yield { type: "error", data: { message: `Model config "${cfg.name}" has invalid JSON params.`, code: "config_parse_error" } };
    return;
  }

  const provider = getProvider(cfg.provider);

  const toolPolicy = runCfg?.allowed_tools?.length
    ? { allow: runCfg.allowed_tools }
    : options?.tool_policy;
  const tools = await getAllToolsAsync(toolPolicy);

  const model = new LangGuiChatModel({ provider, modelId: cfg.model_id, params });
  const store = new SqliteMemoryStore();
  const checkpointer = getCheckpointer();

  const agent = createReactAgent({ llm: model, tools, store, checkpointer });

  // Track which AIMessageChunk-tool-call-chunks we've already announced (by id).
  // We emit a tool_call event once per id when both id+name are known and
  // the assistant turn ends, so callers see structured tool calls (not partial ones).
  const announcedToolIds = new Set<string>();
  let pendingAIChunk: AIMessageChunk | null = null;
  let totalOutputTokens = 0;
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
        configurable: { thread_id: threadId },
        // LangGraph counts EACH node visit (model call + each tool call) as a
        // step, so 10 was hit on any non-trivial multi-tool task. 50 leaves
        // headroom for research-style flows (search → fetch → search → etc.)
        // while still bounding runaway loops. Configurable via env if a
        // specific deployment needs more or less.
        recursionLimit: Number(process.env.LANGGUI_RECURSION_LIMIT) || 50,
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
    const rawMsg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : "";

    // User-initiated abort (Stop button / client disconnect): emit a
    // short error chunk and let the route fall through to `done` so the
    // queued-message drain in the UI fires normally.
    if (signal?.aborted || name === "AbortError" || /aborted/i.test(rawMsg)) {
      yield { type: "error", data: { message: "Run interrupted by user.", code: "aborted" } };
      yield {
        type: "done",
        data: {
          message_id: `llm-${threadId}-${Date.now()}`,
          usage: { input_tokens: 0, output_tokens: totalOutputTokens },
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
      const limit = Number(process.env.LANGGUI_RECURSION_LIMIT) || 50;
      friendly =
        `The agent took too many tool-calling steps without finishing (hit the ${limit}-step limit). ` +
        `If the task is legitimately deep, raise LANGGUI_RECURSION_LIMIT in the env. ` +
        `If the agent looked stuck in a loop (calling the same tool repeatedly), simplify the prompt or ` +
        `try /new to start fresh — long histories of tool results sometimes make the model re-attempt the same step.`;
      code = "recursion_limit";
    }
    // Pull out the FIRST in-app frame from the stack so the user sees what
    // module triggered it, without dumping the full Pregel/webpack trace.
    const firstAppFrame = stack.split("\n").find((l) => /\(rsc\)\.\/lib\//.test(l));
    const trimmed = firstAppFrame ? `\n${firstAppFrame.trim()}` : "";
    yield { type: "error", data: { message: `${friendly}${trimmed}`, code } };
    return;
  }

  yield {
    type: "done",
    data: {
      message_id: `llm-${threadId}-${Date.now()}`,
      usage: { input_tokens: 0, output_tokens: totalOutputTokens },
    },
  };
}
