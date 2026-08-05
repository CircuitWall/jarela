import Anthropic from "@anthropic-ai/sdk";
import type { ContentPart } from "@/lib/tools/types";
import { resolveProviderApiKey } from "./credentials";
import { CACHE_SPLIT_SENTINEL } from "@/lib/agents/prepare/system-prompt";
import type {
  ModelProvider,
  ProviderMessage,
  ProviderParams,
  ProviderStreamResult,
  ProviderStreamEvent,
  InvokeMessage,
  InvokeResult,
  OpenAITool,
} from "./types";

function resolveApiKey(params: ProviderParams): string | undefined {
  return resolveProviderApiKey("anthropic", params);
}

// Models from Opus 4.7 onward (and Sonnet 5+) reject temperature/top_p/top_k
// with a 400. Strip them when the model ID indicates a modern family.
function isModernAnthropicModel(modelId: string): boolean {
  return /claude-(opus-(4-[789]|[5-9])|fable-5|mythos-5|sonnet-5|haiku-4-5)/i.test(modelId);
}

export function pickAnthropicOptions(params: ProviderParams, modelId?: string): Record<string, unknown> {
  const p = params as Record<string, unknown>;
  const modern = modelId ? isModernAnthropicModel(modelId) : false;
  const out: Record<string, unknown> = {};
  const keys: string[] = [
    // temperature/top_p/top_k are removed on Opus 4.7+ / Sonnet 5+
    ...(modern ? [] : ["temperature", "top_p", "top_k"]),
    "stop_sequences",
    "metadata",
    "tool_choice",
    "service_tier",
  ];
  for (const k of keys) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  // Map effort → output_config.effort (Opus 4.6+, Sonnet 4.6+, all 5-family)
  const effort = (p["effort"] as string | undefined);
  if (effort) {
    out["output_config"] = { effort };
  }
  return out;
}

export function appendServerTools(
  anthropicTools: Anthropic.Tool[],
  params: ProviderParams,
): Anthropic.Tool[] {
  const native = (params as Record<string, unknown>).anthropic_server_tools;
  if (!Array.isArray(native)) return anthropicTools;
  const merged = [...anthropicTools];
  for (const t of native) {
    if (t && typeof t === "object") {
      merged.push(t as Anthropic.Tool);
    }
  }
  return merged;
}

// Anthropic prompt-caching breakpoints. Within a multi-tool ReAct turn the
// system prompt + tools are stable across every LLM call, and tool_results
// only grow at the tail — exactly the prefix Anthropic's ephemeral cache is
// built for. We mark three breakpoints (system, last tool, last tool_result)
// so calls 2..N read the prefix at ~10% the input rate. The prefix below the
// minimum cacheable size is silently ignored by the API at no extra cost,
// so it is safe to mark unconditionally.
//
// System-prompt split: buildSystemPrompt() inserts CACHE_SPLIT_SENTINEL
// between the stable prefix (agent persona, harness sections, integrations)
// and the dynamic suffix (current timestamp, per-turn recall, warm summaries).
// withSystemCacheControl recognises the sentinel and emits two content blocks:
// only the stable block carries cache_control so the timestamp change on every
// turn does NOT invalidate the cache for the entire system prompt.
const EPHEMERAL: Anthropic.CacheControlEphemeral = { type: "ephemeral" };

export function withSystemCacheControl(text: string): Anthropic.TextBlockParam[] | undefined {
  if (!text) return undefined;
  const splitIdx = text.indexOf(CACHE_SPLIT_SENTINEL);
  if (splitIdx !== -1) {
    const stable = text.slice(0, splitIdx).trimEnd();
    const dynamic = text.slice(splitIdx + CACHE_SPLIT_SENTINEL.length).trimStart();
    const blocks: Anthropic.TextBlockParam[] = [];
    if (stable) blocks.push({ type: "text", text: stable, cache_control: EPHEMERAL });
    if (dynamic) blocks.push({ type: "text", text: dynamic });
    return blocks.length > 0 ? blocks : undefined;
  }
  return [{ type: "text", text, cache_control: EPHEMERAL }];
}

export function withToolsCacheControl(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (tools.length === 0) return tools;
  const last = tools[tools.length - 1];
  return [...tools.slice(0, -1), { ...last, cache_control: EPHEMERAL }];
}

export function withLastToolResultCacheControl(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (typeof m.content === "string") continue;
    const blocks = m.content;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b.type === "tool_result") {
        const newBlocks = [...blocks];
        newBlocks[j] = { ...b, cache_control: EPHEMERAL };
        const next = [...messages];
        next[i] = { ...m, content: newBlocks };
        return next;
      }
    }
  }
  return messages;
}

interface AnthropicMessageStartEvent {
  type: "message_start";
  message: { usage?: Anthropic.Usage };
}
interface AnthropicMessageDeltaEvent {
  type: "message_delta";
  usage?: Anthropic.MessageDeltaUsage;
}

function usageEventFromStart(usage: Anthropic.Usage | undefined): ProviderStreamEvent | null {
  if (!usage) return null;
  return {
    type: "usage",
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  };
}

function usageEventFromDelta(usage: Anthropic.MessageDeltaUsage | undefined): ProviderStreamEvent | null {
  if (!usage) return null;
  // message_delta only carries the *final* output_tokens; input/cache fields
  // are already accounted for from message_start. Emitting just the output
  // delta here keeps the agent loop's running total accurate without
  // double-counting cache reads.
  return {
    type: "usage",
    input_tokens: 0,
    output_tokens: usage.output_tokens ?? 0,
  };
}

export const anthropicProvider: ModelProvider = {
  name: "anthropic",

  async chat(model_id, messages, params): Promise<ProviderStreamResult> {
    const client = new Anthropic({
      apiKey: resolveApiKey(params),
      baseURL: params.base_url,
      defaultHeaders: params.extra_headers,
    });

    const systemMsg = messages.find((m) => m.role === "system");
    const systemText = typeof systemMsg?.content === "string"
      ? systemMsg.content
      : (systemMsg?.content ?? [])
          .filter((p): p is ContentPart & { type: "text" } => p.type === "text")
          .map((p) => p.text)
          .join("\n");
    const userMessages = messages
      .filter((m) => m.role !== "system")
      .map((m): Anthropic.MessageParam => ({
        role: (m.role === "assistant" ? "assistant" : "user"),
        content: toAnthropicContent(m.content),
      }));

    const stream = await client.messages.stream({
      model: model_id,
      max_tokens: params.max_tokens ?? 4096,
      system: withSystemCacheControl(systemText),
      messages: userMessages,
    });

    return {
      stream: (async function* () {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield event.delta.text;
          }
        }
      })(),
    };
  },

  async invoke(model_id, messages, params, tools): Promise<InvokeResult> {
    const client = new Anthropic({
      apiKey: resolveApiKey(params),
      baseURL: params.base_url,
      defaultHeaders: params.extra_headers,
    });

    const systemMsg = messages.find((m) => m.role === "system");
    const systemText = typeof systemMsg?.content === "string" ? systemMsg.content : "";
    const msgList = withLastToolResultCacheControl(
      toAnthropicMessages(messages.filter((m) => m.role !== "system")),
    );
    const anthropicTools = withToolsCacheControl(
      appendServerTools(toAnthropicTools(tools), params),
    );

    const resp = await client.messages.create({
      model: model_id,
      max_tokens: params.max_tokens ?? 4096,
      system: withSystemCacheControl(systemText),
      messages: msgList,
      tools: anthropicTools,
      ...(params.thinking ? { thinking: resolveThinkingParam(params.thinking, model_id) } : {}),
      ...(pickAnthropicOptions(params, model_id) as Record<string, unknown>),
    });

    const textContent = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const toolCalls = resp.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, arguments: b.input as Record<string, unknown> }));

    return {
      text: textContent || null,
      tool_calls: toolCalls,
      stop_reason: resp.stop_reason === "tool_use" ? "tool_use" : "stop",
    };
  },

  streamInvoke(model_id, messages, params, tools): AsyncIterable<ProviderStreamEvent> {
    return (async function* () {
      const client = new Anthropic({
        apiKey: resolveApiKey(params),
        baseURL: params.base_url,
        defaultHeaders: params.extra_headers,
      });

      const systemMsg = messages.find((m) => m.role === "system");
      const systemText = typeof systemMsg?.content === "string" ? systemMsg.content : "";
      const msgList = withLastToolResultCacheControl(
        toAnthropicMessages(messages.filter((m) => m.role !== "system")),
      );
      const anthropicTools = withToolsCacheControl(
        appendServerTools(toAnthropicTools(tools), params),
      );

      const body: Anthropic.Messages.MessageStreamParams = {
        model: model_id,
        max_tokens: params.max_tokens ?? 4096,
        messages: msgList,
        ...(pickAnthropicOptions(params, model_id) as Record<string, unknown>),
      };
      const systemParam = withSystemCacheControl(systemText);
      if (systemParam) body.system = systemParam;
      if (anthropicTools.length > 0) body.tools = anthropicTools;
      if (params.thinking) {
        (body as unknown as Record<string, unknown>).thinking = resolveThinkingParam(params.thinking, model_id);
      }
      // temperature is stripped for modern models inside pickAnthropicOptions;
      // guard here is only for the legacy non-modern path where it was set top-level.
      if (params.temperature !== undefined && !isModernAnthropicModel(model_id)) body.temperature = params.temperature;

      const stream = client.messages.stream(body);
      const blockType = new Map<number, "text" | "thinking" | "tool_use">();

      for await (const event of stream) {
        if (event.type === "message_start") {
          const ev = event as unknown as AnthropicMessageStartEvent;
          const u = usageEventFromStart(ev.message?.usage);
          if (u) yield u;
          continue;
        }
        if (event.type === "content_block_start") {
          const cb = event.content_block;
          if (cb.type === "tool_use") {
            blockType.set(event.index, "tool_use");
            yield { type: "tool_call_chunk", index: event.index, id: cb.id, name: cb.name };
          } else if (cb.type === "thinking") {
            blockType.set(event.index, "thinking");
          } else if (cb.type === "text") {
            blockType.set(event.index, "text");
          }
        } else if (event.type === "content_block_delta") {
          const d = event.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
          if (d.type === "text_delta" && d.text) {
            yield { type: "text", delta: d.text };
          } else if (d.type === "thinking_delta" && d.thinking) {
            yield { type: "thinking", delta: d.thinking };
          } else if (d.type === "input_json_delta" && d.partial_json !== undefined) {
            yield { type: "tool_call_chunk", index: event.index, args_delta: d.partial_json };
          }
        } else if (event.type === "message_delta") {
          const delta = event as unknown as AnthropicMessageDeltaEvent;
          const u = usageEventFromDelta(delta.usage);
          if (u) yield u;
          if (event.delta?.stop_reason) {
            const reason = event.delta.stop_reason;
            yield { type: "stop", reason: reason === "tool_use" ? "tool_use" : reason === "max_tokens" ? "length" : "stop" };
          }
        }
      }
    })();
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

// Anthropic deprecated {type:"enabled", budget_tokens:N} on Opus 4.6/Sonnet 4.6
// and removed it on Opus 4.7+. Auto-upgrade to {type:"adaptive"} for models
// where the old shape would 400.
function resolveThinkingParam(
  thinking: Record<string, unknown>,
  modelId: string,
): Record<string, unknown> {
  if (thinking.type === "enabled" && isModernAnthropicModel(modelId)) {
    return { type: "adaptive" };
  }
  return thinking;
}

export function toAnthropicContent(
  content: string | ContentPart[],
): Anthropic.MessageParam["content"] {
  if (typeof content === "string") return content;
  return content.flatMap((part): Anthropic.ContentBlockParam[] => {
    if (part.type === "text") {
      return [{ type: "text", text: part.text }];
    }
    if (part.type === "image") {
      const mt = part.media_type as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      return [{ type: "image", source: { type: "base64", media_type: mt, data: part.data } }];
    }
    if (part.type === "image_ref") {
      // See ADR-0065. Refs are normally unwrapped by `toBaseMessages` in
      // `lib/agents/llm.ts` before providers see them; this is a defensive
      // fallback for any caller that bypasses that path.
      return [{ type: "text", text: `[image attachment: ${part.media_type}]` }];
    }
    if (part.type === "file") {
      if (part.media_type === "application/pdf") {
        return [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: part.data },
            title: part.name,
          } as unknown as Anthropic.ContentBlockParam,
        ];
      }
      return [{ type: "text", text: `[File: ${part.name}]\n${part.data}` }];
    }
    return [];
  });
}

export function toAnthropicMessages(messages: InvokeMessage[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      result.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id!, content: String(m.content) }],
      });
    } else if (m.role === "assistant" && m.tool_calls?.length) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: "text", text: String(m.content) });
      for (const tc of m.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name ?? "",
          input: (() => {
            try {
              return JSON.parse(tc.function?.arguments ?? "{}");
            } catch {
              return {};
            }
          })(),
        });
      }
      result.push({ role: "assistant", content: blocks });
    } else {
      result.push({
        role: m.role as "user" | "assistant",
        content: toAnthropicContent(m.content),
      });
    }
  }
  return result;
}

export function toAnthropicTools(tools: OpenAITool[]): Anthropic.Tool[] {
  return tools.flatMap((t) => {
    if (!t.function?.name) return [];
    return [{ name: t.function.name, description: t.function.description, input_schema: t.function.parameters as Anthropic.Tool.InputSchema }];
  });
}

// Reusable body builder + stream translator so a second host (e.g. GitHub
// Copilot's native /v1/messages endpoint, exposed at api.githubcopilot.com
// for Claude-family models) can ride the exact same cache_control breakpoints
// and event shape as the direct Anthropic adapter.

export function buildAnthropicMessageBody(
  model_id: string,
  messages: InvokeMessage[],
  params: ProviderParams,
  tools: OpenAITool[],
): Anthropic.Messages.MessageCreateParams {
  const systemMsg = messages.find((m) => m.role === "system");
  const systemText = typeof systemMsg?.content === "string" ? systemMsg.content : "";
  const msgList = withLastToolResultCacheControl(
    toAnthropicMessages(messages.filter((m) => m.role !== "system")),
  );
  const anthropicTools = withToolsCacheControl(
    appendServerTools(toAnthropicTools(tools), params),
  );
  const body: Anthropic.Messages.MessageCreateParams = {
    model: model_id,
    max_tokens: params.max_tokens ?? 4096,
    messages: msgList,
    ...(pickAnthropicOptions(params, model_id) as Record<string, unknown>),
  };
  const systemParam = withSystemCacheControl(systemText);
  if (systemParam) body.system = systemParam;
  if (anthropicTools.length > 0) body.tools = anthropicTools;
  if (params.thinking) {
    (body as unknown as Record<string, unknown>).thinking = resolveThinkingParam(params.thinking as Record<string, unknown>, model_id);
  }
  if (params.temperature !== undefined && !isModernAnthropicModel(model_id)) body.temperature = params.temperature;
  return body;
}

export async function* translateAnthropicStreamEvents(
  stream: AsyncIterable<Anthropic.Messages.MessageStreamEvent>,
): AsyncIterable<ProviderStreamEvent> {
  for await (const event of stream) {
    if (event.type === "message_start") {
      const ev = event as unknown as AnthropicMessageStartEvent;
      const u = usageEventFromStart(ev.message?.usage);
      if (u) yield u;
      continue;
    }
    if (event.type === "content_block_start") {
      const cb = event.content_block;
      if (cb.type === "tool_use") {
        yield { type: "tool_call_chunk", index: event.index, id: cb.id, name: cb.name };
      }
    } else if (event.type === "content_block_delta") {
      const d = event.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
      if (d.type === "text_delta" && d.text) {
        yield { type: "text", delta: d.text };
      } else if (d.type === "thinking_delta" && d.thinking) {
        yield { type: "thinking", delta: d.thinking };
      } else if (d.type === "input_json_delta" && d.partial_json !== undefined) {
        yield { type: "tool_call_chunk", index: event.index, args_delta: d.partial_json };
      }
    } else if (event.type === "message_delta") {
      const delta = event as unknown as AnthropicMessageDeltaEvent;
      const u = usageEventFromDelta(delta.usage);
      if (u) yield u;
      if (event.delta?.stop_reason) {
        const reason = event.delta.stop_reason;
        yield { type: "stop", reason: reason === "tool_use" ? "tool_use" : reason === "max_tokens" ? "length" : "stop" };
      }
    }
  }
}
