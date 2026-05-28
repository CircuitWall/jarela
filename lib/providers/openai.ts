import OpenAI from "openai";
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

function pickOpenAICompatOptions(params: ProviderParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const p = params as Record<string, unknown>;
  const keys = [
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "stop",
    "response_format",
    "logprobs",
    "top_logprobs",
    "reasoning_effort",
    "thinking",
    "stream_options",
    "user",
    "user_id",
  ];
  for (const k of keys) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  return out;
}

function makeClient(
  params: ProviderParams,
  baseURL?: string,
  extraHeaders?: Record<string, string>,
): OpenAI {
  return new OpenAI({
    apiKey: params.api_key ?? process.env.OPENAI_API_KEY,
    baseURL: params.base_url ?? baseURL,
    defaultHeaders: { ...params.extra_headers, ...extraHeaders },
  });
}

// Convert ContentPart[] to OpenAI multipart content
function toOpenAIContent(
  content: string | ContentPart[],
): string | OpenAI.Chat.ChatCompletionContentPart[] {
  if (typeof content === "string") return content;
  return content.map((part): OpenAI.Chat.ChatCompletionContentPart => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      return {
        type: "image_url",
        image_url: { url: `data:${part.media_type};base64,${part.data}` },
      };
    }
    // Files rendered as text for OpenAI
    return { type: "text", text: `[File: ${(part as ContentPart & { type: "file" }).name}]\n${part.data}` };
  });
}

function toOpenAIMessages(
  messages: InvokeMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id!, content: String(m.content) };
    }
    if (m.role === "assistant") {
      const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam & { reasoning_content?: string } = {
        role: "assistant",
        content: typeof m.content === "string" ? m.content : null,
        tool_calls: m.tool_calls as OpenAI.Chat.ChatCompletionMessageToolCall[] | undefined,
      };
      // DeepSeek's reasoning models reject follow-up requests that omit the
      // assistant's prior reasoning_content. The OpenAI SDK's type doesn't
      // know about this field, but the underlying HTTP body forwards it.
      if (m.reasoning_content) msg.reasoning_content = m.reasoning_content;
      return msg as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    }
    return {
      role: m.role as "system" | "user",
      content: toOpenAIContent(m.content),
    } as OpenAI.Chat.ChatCompletionMessageParam;
  });
}

// Re-export so other OpenAI-compatible providers (github-copilot, etc.) can
// share the same ContentPart -> wire-format conversion instead of casting
// raw InvokeMessage shapes that the OpenAI SDK then rejects for images/files.
export { toOpenAIContent, toOpenAIMessages };

function ollamaOriginFromParams(params: ProviderParams): string | null {
  const raw = typeof params.base_url === "string" ? params.base_url : "";
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    const isOllamaPort = u.port === "11434";
    if (!isLocal || !isOllamaPort) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

async function tryPullOllamaModel(model_id: string, params: ProviderParams): Promise<boolean> {
  const origin = ollamaOriginFromParams(params);
  if (!origin) return false;
  try {
    const res = await fetch(`${origin}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: model_id, stream: false }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function isModelNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b|model.*not found|unsupported.*embed/i.test(msg);
}

export const openaiProvider: ModelProvider = {
  name: "openai",

  async chat(model_id, messages, params): Promise<ProviderStreamResult> {
    const client = makeClient(params);
    const mapped = messages.map((m): InvokeMessage => ({
      role: m.role,
      content: m.content,
    }));
    const stream = await client.chat.completions.create({
      model: model_id,
      messages: toOpenAIMessages(mapped),
      stream: true,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
      ...(pickOpenAICompatOptions(params) as Record<string, unknown>),
    });
    return {
      stream: (async function* () {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) yield delta;
        }
      })(),
    };
  },

  async invoke(model_id, messages, params, tools): Promise<InvokeResult> {
    const client = makeClient(params);
    const resp = await client.chat.completions.create({
      model: model_id,
      messages: toOpenAIMessages(messages),
      tools: tools as OpenAI.Chat.ChatCompletionTool[],
      tool_choice: "auto",
      stream: false,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
      ...(pickOpenAICompatOptions(params) as Record<string, unknown>),
    });
    const choice = resp.choices[0];
    return {
      text: choice.message.content ?? null,
      tool_calls: (choice.message.tool_calls ?? []).flatMap((tc) => {
        if (tc?.type !== "function" || !tc.function?.name) return [];
        return [{
          id: tc.id,
          name: tc.function.name,
          arguments: (() => {
            try {
              return JSON.parse(tc.function.arguments) as Record<string, unknown>;
            } catch {
              return {};
            }
          })(),
        }];
      }),
      stop_reason: choice.finish_reason === "tool_calls" ? "tool_use" : "stop",
    };
  },

  streamInvoke(model_id, messages, params, tools): AsyncIterable<ProviderStreamEvent> {
    return openaiStreamInvoke(makeClient(params), model_id, messages, params, tools);
  },

  async embed(model_id, inputs, params): Promise<number[][]> {
    return openaiEmbed(makeClient(params), model_id, inputs, params);
  },
};

async function openaiEmbed(
  client: OpenAI,
  model_id: string,
  inputs: string[],
  params: ProviderParams,
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  try {
    const resp = await client.embeddings.create({ model: model_id, input: inputs });
    return resp.data.map((d) => d.embedding);
  } catch (err) {
    // Self-host ergonomics: when pointed at local Ollama and the embedding
    // model isn't present yet, pull it on-demand and retry once.
    if (isModelNotFoundError(err) && await tryPullOllamaModel(model_id, params)) {
      const resp = await client.embeddings.create({ model: model_id, input: inputs });
      return resp.data.map((d) => d.embedding);
    }
    throw err;
  }
}

async function* openaiStreamInvoke(
  client: OpenAI,
  model_id: string,
  messages: InvokeMessage[],
  params: ProviderParams,
  tools: OpenAITool[],
): AsyncIterable<ProviderStreamEvent> {
  const body: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
    model: model_id,
    messages: toOpenAIMessages(messages),
    stream: true,
    temperature: params.temperature,
    max_tokens: params.max_tokens,
    ...(pickOpenAICompatOptions(params) as Record<string, unknown>),
  };
  if (tools.length > 0) {
    body.tools = tools as OpenAI.Chat.ChatCompletionTool[];
    body.tool_choice = "auto";
  }
  const stream = await client.chat.completions.create(body);
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) continue;
    const delta = choice.delta as {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    if (delta.content) yield { type: "text", delta: delta.content };
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      yield { type: "thinking", delta: delta.reasoning_content };
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        yield {
          type: "tool_call_chunk",
          index: tc.index ?? 0,
          id: tc.id,
          name: tc.function?.name,
          args_delta: tc.function?.arguments,
        };
      }
    }
    if (choice.finish_reason) {
      const fr = choice.finish_reason;
      yield { type: "stop", reason: fr === "tool_calls" ? "tool_use" : fr === "length" ? "length" : "stop" };
    }
  }
}

export function makeOpenAICompatProvider(
  providerName: string,
  defaultBaseURL: string,
  fixedHeaders: Record<string, string>,
): ModelProvider {
  return {
    name: providerName,

    async chat(model_id, messages, params): Promise<ProviderStreamResult> {
      const client = makeClient(params, defaultBaseURL, fixedHeaders);
      const mapped = messages.map((m): InvokeMessage => ({
        role: m.role,
        content: m.content,
      }));
      const stream = await client.chat.completions.create({
        model: model_id,
        messages: toOpenAIMessages(mapped),
        stream: true,
        temperature: params.temperature,
        max_tokens: params.max_tokens,
        ...(pickOpenAICompatOptions(params) as Record<string, unknown>),
      });
      return {
        stream: (async function* () {
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) yield delta;
          }
        })(),
      };
    },

    async invoke(model_id, messages, params, tools): Promise<InvokeResult> {
      const client = makeClient(params, defaultBaseURL, fixedHeaders);
      const resp = await client.chat.completions.create({
        model: model_id,
        messages: toOpenAIMessages(messages),
        tools: tools as OpenAI.Chat.ChatCompletionTool[],
        tool_choice: "auto",
        stream: false,
        temperature: params.temperature,
        max_tokens: params.max_tokens,
        ...(pickOpenAICompatOptions(params) as Record<string, unknown>),
      });
      const choice = resp.choices[0];
      return {
        text: choice.message.content ?? null,
        tool_calls: (choice.message.tool_calls ?? []).flatMap((tc) => {
          if (tc?.type !== "function" || !tc.function?.name) return [];
          return [{
            id: tc.id,
            name: tc.function.name,
            arguments: (() => {
              try {
                return JSON.parse(tc.function.arguments) as Record<string, unknown>;
              } catch {
                return {};
              }
            })(),
          }];
        }),
        stop_reason: choice.finish_reason === "tool_calls" ? "tool_use" : "stop",
      };
    },

    streamInvoke(model_id, messages, params, tools): AsyncIterable<ProviderStreamEvent> {
      return openaiStreamInvoke(makeClient(params, defaultBaseURL, fixedHeaders), model_id, messages, params, tools);
    },

    async embed(model_id, inputs, params): Promise<number[][]> {
      return openaiEmbed(makeClient(params, defaultBaseURL, fixedHeaders), model_id, inputs, params);
    },
  };
}


