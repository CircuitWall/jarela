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
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((p): p is ContentPart & { type: "text" } => p.type === "text")
              .map((p) => p.text)
              .join("\n");
      return m.role === "user" ? new HumanMessage(text) : new AIMessage(text);
    }),
  ];
}

export async function* streamWithConfig(
  threadId: string,
  messages: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>,
  options?: StreamOptions,
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
