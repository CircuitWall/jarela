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
      return {
        role: "assistant",
        content: typeof m.content === "string" ? m.content : null,
        tool_calls: m.tool_calls as OpenAI.Chat.ChatCompletionMessageToolCall[] | undefined,
      } as OpenAI.Chat.ChatCompletionAssistantMessageParam;
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

export const openaiProvider: ModelProvider = {
  name: "openai",

  async chat(model_id, messages, params): Promise<ProviderStreamResult> {
    const client = makeClient(params);
    const stream = await client.chat.completions.create({
      model: model_id,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      stream: true,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
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
    });
    const choice = resp.choices[0];
    return {
      text: choice.message.content ?? null,
      tool_calls: (choice.message.tool_calls ?? []).flatMap((tc) => {
        if (!tc?.function?.name) return [];
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
    return openaiEmbed(makeClient(params), model_id, inputs);
  },
};

async function openaiEmbed(client: OpenAI, model_id: string, inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const resp = await client.embeddings.create({ model: model_id, input: inputs });
  return resp.data.map((d) => d.embedding);
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
      const stream = await client.chat.completions.create({
        model: model_id,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        stream: true,
        temperature: params.temperature,
        max_tokens: params.max_tokens,
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
      });
      const choice = resp.choices[0];
      return {
        text: choice.message.content ?? null,
        tool_calls: (choice.message.tool_calls ?? []).flatMap((tc) => {
          if (!tc?.function?.name) return [];
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
      return openaiEmbed(makeClient(params, defaultBaseURL, fixedHeaders), model_id, inputs);
    },
  };
}


