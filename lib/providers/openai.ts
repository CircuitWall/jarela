import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ContentPart } from "@/lib/tools/types";
import { resolveProviderApiKey } from "./credentials";
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
import { errorMessage } from "@/lib/utils/error";

// Re-export so callers can pass zodResponseFormat(schema, name) as params.response_format
// without importing from openai/helpers/zod directly.
export { zodResponseFormat };

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

// gpt-5* and o1/o3/o4 reasoning models reject `max_tokens` and require
// `max_completion_tokens` instead.
export function isOpenAIReasoningModel(model_id: string): boolean {
  return /^(gpt-5|o[134](?:-|$))/i.test(model_id);
}

export function openaiTokenLimitParams(
  model_id: string,
  params: ProviderParams,
): Record<string, number | undefined> {
  if (params.max_tokens == null) return {};
  return isOpenAIReasoningModel(model_id)
    ? { max_completion_tokens: params.max_tokens }
    : { max_tokens: params.max_tokens };
}

function makeClient(
  params: ProviderParams,
  baseURL?: string,
  extraHeaders?: Record<string, string>,
  providerName: string = "openai",
): OpenAI {
  return new OpenAI({
    apiKey: resolveProviderApiKey(providerName, params),
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
    if (part.type === "image_ref") {
      // Providers see refs only when a caller invoked the OpenAI adapter
      // directly (bypassing `toBaseMessages` in `lib/agents/llm.ts`).
      // Fall back to a text placeholder — vision blocks can't be filled
      // without the base64 payload, which lives on disk. See ADR-0065.
      return { type: "text", text: `[image attachment: ${part.media_type}]` };
    }
    // Files rendered as text for OpenAI
    return { type: "text", text: `[File: ${part.name}]\n${part.data}` };
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

type OpenAIStreamDelta = {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
};

type OpenAIStreamChoice = {
  delta?: OpenAIStreamDelta;
  finish_reason?: string | null;
};

type OpenAIInvokeChoice = {
  message?: {
    content?: string | null;
    tool_calls?: Array<{ type?: string; id?: string; function?: { name?: string; arguments?: string } }>;
  };
  finish_reason?: string | null;
};

function parseStopReason(reason: string | null | undefined): InvokeResult["stop_reason"] {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "length";
  return "stop";
}

export function parseOpenAIInvokeChoice(choice: OpenAIInvokeChoice): InvokeResult {
  return {
    text: choice.message?.content ?? null,
    tool_calls: (choice.message?.tool_calls ?? []).flatMap((tc) => {
      if (tc?.type !== "function" || !tc.function?.name) return [];
      return [{
        id: tc.id ?? "",
        name: tc.function.name,
        arguments: (() => {
          try {
            return JSON.parse(tc.function.arguments ?? "{}") as Record<string, unknown>;
          } catch {
            return {};
          }
        })(),
      }];
    }),
    stop_reason: parseStopReason(choice.finish_reason),
  };
}

interface OpenAIUsageDetails {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export async function* streamOpenAIEvents(
  stream: AsyncIterable<{
    choices?: OpenAIStreamChoice[];
    usage?: OpenAIUsageDetails | null;
  }>,
): AsyncIterable<ProviderStreamEvent> {
  for await (const chunk of stream) {
    if (chunk.usage) {
      yield {
        type: "usage",
        input_tokens: chunk.usage.prompt_tokens,
        output_tokens: chunk.usage.completion_tokens,
        total_tokens: chunk.usage.total_tokens,
        cache_read_input_tokens: chunk.usage.prompt_tokens_details?.cached_tokens,
        thinking_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
      };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;
    if (!delta) continue;
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
      yield { type: "stop", reason: parseStopReason(choice.finish_reason) };
    }
  }
}

async function streamOpenAIText(
  stream: AsyncIterable<{ choices?: Array<{ delta?: { content?: string | null } }> }>,
): Promise<ProviderStreamResult> {
  return {
    stream: (async function* () {
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    })(),
  };
}

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
  const msg = errorMessage(err);
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
      ...openaiTokenLimitParams(model_id, params),
      ...(pickOpenAICompatOptions(params) as Record<string, unknown>),
    });
    return streamOpenAIText(stream);
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
      ...openaiTokenLimitParams(model_id, params),
      ...(pickOpenAICompatOptions(params) as Record<string, unknown>),
    });
    return parseOpenAIInvokeChoice(resp.choices[0] as OpenAIInvokeChoice);
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
  const compatOptions = pickOpenAICompatOptions(params) as Record<string, unknown>;
  const body: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
    model: model_id,
    messages: toOpenAIMessages(messages),
    stream: true,
    temperature: params.temperature,
    ...openaiTokenLimitParams(model_id, params),
    ...compatOptions,
    stream_options: { include_usage: true, ...(compatOptions.stream_options as object | undefined) },
  };
  if (tools.length > 0) {
    body.tools = tools as OpenAI.Chat.ChatCompletionTool[];
    body.tool_choice = "auto";
  }
  const stream = await client.chat.completions.create(body);
  yield* streamOpenAIEvents(
    stream as AsyncIterable<{
      choices?: OpenAIStreamChoice[];
      usage?: OpenAIUsageDetails | null;
    }>,
  );
}

export function makeOpenAICompatProvider(
  providerName: string,
  defaultBaseURL: string,
  fixedHeaders: Record<string, string>,
): ModelProvider {
  return {
    name: providerName,

    async chat(model_id, messages, params): Promise<ProviderStreamResult> {
      const client = makeClient(params, defaultBaseURL, fixedHeaders, providerName);
      const mapped = messages.map((m): InvokeMessage => ({
        role: m.role,
        content: m.content,
      }));
      const stream = await client.chat.completions.create({
        model: model_id,
        messages: toOpenAIMessages(mapped),
        stream: true,
        temperature: params.temperature,
        ...openaiTokenLimitParams(model_id, params),
        ...(pickOpenAICompatOptions(params) as Record<string, unknown>),
      });
      return streamOpenAIText(stream);
    },

    async invoke(model_id, messages, params, tools): Promise<InvokeResult> {
      const client = makeClient(params, defaultBaseURL, fixedHeaders, providerName);
      const resp = await client.chat.completions.create({
        model: model_id,
        messages: toOpenAIMessages(messages),
        tools: tools as OpenAI.Chat.ChatCompletionTool[],
        tool_choice: "auto",
        stream: false,
        temperature: params.temperature,
        ...openaiTokenLimitParams(model_id, params),
        ...(pickOpenAICompatOptions(params) as Record<string, unknown>),
      });
      return parseOpenAIInvokeChoice(resp.choices[0] as OpenAIInvokeChoice);
    },

    streamInvoke(model_id, messages, params, tools): AsyncIterable<ProviderStreamEvent> {
      return openaiStreamInvoke(makeClient(params, defaultBaseURL, fixedHeaders, providerName), model_id, messages, params, tools);
    },

    async embed(model_id, inputs, params): Promise<number[][]> {
      return openaiEmbed(makeClient(params, defaultBaseURL, fixedHeaders, providerName), model_id, inputs, params);
    },
  };
}


