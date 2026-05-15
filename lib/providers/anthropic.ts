import Anthropic from "@anthropic-ai/sdk";
import type { ContentPart } from "@/lib/tools/types";
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

export const anthropicProvider: ModelProvider = {
  name: "anthropic",

  async chat(model_id, messages, params): Promise<ProviderStreamResult> {
    const client = new Anthropic({
      apiKey: params.api_key ?? process.env.ANTHROPIC_API_KEY,
      baseURL: params.base_url,
      defaultHeaders: params.extra_headers,
    });

    const systemMsg = messages.find((m) => m.role === "system");
    const userMessages = messages.filter((m) => m.role !== "system") as Anthropic.MessageParam[];

    const stream = await client.messages.stream({
      model: model_id,
      max_tokens: params.max_tokens ?? 4096,
      system: systemMsg?.content,
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
      apiKey: params.api_key ?? process.env.ANTHROPIC_API_KEY,
      baseURL: params.base_url,
      defaultHeaders: params.extra_headers,
    });

    const systemMsg = messages.find((m) => m.role === "system");
    const msgList = toAnthropicMessages(messages.filter((m) => m.role !== "system"));
    const anthropicTools = toAnthropicTools(tools);

    const resp = await client.messages.create({
      model: model_id,
      max_tokens: params.max_tokens ?? 4096,
      system: typeof systemMsg?.content === "string" ? systemMsg.content : undefined,
      messages: msgList,
      tools: anthropicTools,
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
        apiKey: params.api_key ?? process.env.ANTHROPIC_API_KEY,
        baseURL: params.base_url,
        defaultHeaders: params.extra_headers,
      });

      const systemMsg = messages.find((m) => m.role === "system");
      const msgList = toAnthropicMessages(messages.filter((m) => m.role !== "system"));
      const anthropicTools = toAnthropicTools(tools);

      const body: Anthropic.Messages.MessageStreamParams = {
        model: model_id,
        max_tokens: params.max_tokens ?? 4096,
        messages: msgList,
      };
      if (typeof systemMsg?.content === "string") body.system = systemMsg.content;
      if (anthropicTools.length > 0) body.tools = anthropicTools;
      if (params.thinking) {
        (body as unknown as Record<string, unknown>).thinking = params.thinking;
      }
      if (params.temperature !== undefined) body.temperature = params.temperature;

      const stream = client.messages.stream(body);
      const blockType = new Map<number, "text" | "thinking" | "tool_use">();

      for await (const event of stream) {
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
        } else if (event.type === "message_delta" && event.delta?.stop_reason) {
          const reason = event.delta.stop_reason;
          yield { type: "stop", reason: reason === "tool_use" ? "tool_use" : reason === "max_tokens" ? "length" : "stop" };
        }
      }
    })();
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function toAnthropicContent(
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

function toAnthropicMessages(messages: InvokeMessage[]): Anthropic.MessageParam[] {
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

function toAnthropicTools(tools: OpenAITool[]): Anthropic.Tool[] {
  return tools.flatMap((t) => {
    if (!t.function?.name) return [];
    return [{ name: t.function.name, description: t.function.description, input_schema: t.function.parameters as Anthropic.Tool.InputSchema }];
  });
}

// ── Plain-text helper for streaming path (no tool calls) ────────────────────

export function providerMessagesFromHistory(
  messages: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>,
): ProviderMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string"
      ? m.content
      : m.content.filter((p): p is ContentPart & { type: "text" } => p.type === "text").map((p) => p.text).join("\n"),
  }));
}
