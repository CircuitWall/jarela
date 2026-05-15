import { BaseChatModel, type BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  isAIMessage,
  isHumanMessage,
  isSystemMessage,
  isToolMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatGeneration, type ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { Runnable } from "@langchain/core/runnables";
import type { ModelProvider, ProviderParams } from "@/lib/providers/types";
import type { ContentPart, InvokeMessage, OpenAITool, ToolParamSchema } from "@/lib/tools/types";

interface Fields {
  provider: ModelProvider;
  modelId: string;
  params: ProviderParams;
  boundTools?: StructuredToolInterface[];
}

export class LangGuiChatModel extends BaseChatModel {
  lc_namespace = ["langgui", "chat_models"];
  lc_serializable = false;

  private _provider: ModelProvider;
  private _modelId: string;
  private _params: ProviderParams;
  private _boundTools: StructuredToolInterface[];

  constructor(fields: Fields) {
    super({});
    this._provider = fields.provider;
    this._modelId = fields.modelId;
    this._params = fields.params;
    this._boundTools = fields.boundTools ?? [];
  }

  _llmType(): string {
    return `langgui_${this._provider?.name ?? "chat"}`;
  }

  // createReactAgent calls bindTools() to attach the tool list before streaming.
  bindTools(tools: StructuredToolInterface[], _kwargs?: Partial<BaseChatModelCallOptions>): Runnable {
    return new LangGuiChatModel({
      provider: this._provider,
      modelId: this._modelId,
      params: this._params,
      boundTools: tools,
    });
  }

  private _convertedTools(): OpenAITool[] {
    return this._boundTools.flatMap((t) => {
      try {
        const oai = convertToOpenAITool(t) as { function?: { name?: string; description?: string; parameters: unknown } };
        if (!oai?.function?.name) return [];
        return [{
          type: "function" as const,
          function: {
            name: oai.function.name,
            description: oai.function.description ?? "",
            parameters: oai.function.parameters as ToolParamSchema,
          },
        }];
      } catch {
        return [];
      }
    });
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const invokeMessages = toInvokeMessages(messages);
    const openaiTools = this._convertedTools();

    // Streaming path — assemble chunks into a final message.
    if (this._provider.streamInvoke && openaiTools.length > 0) {
      const finalChunk = await this._streamToFinalChunk(invokeMessages, openaiTools, runManager);
      const gen: ChatGeneration = {
        message: aiMessageFromChunk(finalChunk.message as AIMessageChunk),
        text: typeof finalChunk.message.content === "string" ? finalChunk.message.content : "",
      };
      return { generations: [gen] };
    }

    if (this._provider.invoke && openaiTools.length > 0) {
      const result = await this._provider.invoke(this._modelId, invokeMessages, this._params, openaiTools);
      const aiMsg = new AIMessage({
        content: result.text ?? "",
        tool_calls: result.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          args: tc.arguments,
          type: "tool_call" as const,
        })),
      });
      const gen: ChatGeneration = { message: aiMsg, text: result.text ?? "" };
      return { generations: [gen] };
    }

    const providerMessages = invokeMessages
      .filter((m) => m.role !== "tool")
      .map((m) => ({ role: m.role as "user" | "assistant" | "system", content: String(m.content) }));
    const { stream } = await this._provider.chat(this._modelId, providerMessages, this._params);
    let text = "";
    for await (const chunk of stream) { text += chunk; }
    const gen: ChatGeneration = { message: new AIMessage(text), text };
    return { generations: [gen] };
  }

  private async _streamToFinalChunk(
    invokeMessages: InvokeMessage[],
    openaiTools: OpenAITool[],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatGenerationChunk> {
    let acc: ChatGenerationChunk | null = null;
    for await (const chunk of this._streamFromProvider(invokeMessages, openaiTools, runManager)) {
      acc = acc ? acc.concat(chunk) : chunk;
    }
    return acc ?? new ChatGenerationChunk({ message: new AIMessageChunk({ content: "" }), text: "" });
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const invokeMessages = toInvokeMessages(messages);
    const openaiTools = this._convertedTools();

    if (!this._provider.streamInvoke) {
      const result = await this._generate(messages, _options, runManager);
      const msg = result.generations[0].message as AIMessage;
      yield new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: msg.content,
          tool_call_chunks: msg.tool_calls?.map((tc, i) => ({
            index: i,
            id: tc.id,
            name: tc.name,
            args: JSON.stringify(tc.args),
            type: "tool_call_chunk" as const,
          })) ?? [],
        }),
        text: typeof msg.content === "string" ? msg.content : "",
      });
      return;
    }

    yield* this._streamFromProvider(invokeMessages, openaiTools, runManager);
  }

  private async *_streamFromProvider(
    invokeMessages: InvokeMessage[],
    openaiTools: OpenAITool[],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    if (!this._provider.streamInvoke) return;
    for await (const event of this._provider.streamInvoke(this._modelId, invokeMessages, this._params, openaiTools)) {
      if (event.type === "text") {
        await runManager?.handleLLMNewToken(event.delta);
        yield new ChatGenerationChunk({
          message: new AIMessageChunk({ content: event.delta }),
          text: event.delta,
        });
      } else if (event.type === "thinking") {
        yield new ChatGenerationChunk({
          message: new AIMessageChunk({
            content: "",
            additional_kwargs: { reasoning_content: event.delta },
          }),
          text: "",
        });
      } else if (event.type === "tool_call_chunk") {
        yield new ChatGenerationChunk({
          message: new AIMessageChunk({
            content: "",
            tool_call_chunks: [{
              index: event.index,
              id: event.id,
              name: event.name,
              args: event.args_delta,
              type: "tool_call_chunk" as const,
            }],
          }),
          text: "",
        });
      }
    }
  }
}

function aiMessageFromChunk(chunk: AIMessageChunk): AIMessage {
  return new AIMessage({
    content: chunk.content,
    tool_calls: chunk.tool_calls,
    invalid_tool_calls: chunk.invalid_tool_calls,
    additional_kwargs: chunk.additional_kwargs,
  });
}

// LangChain's BaseMessage.content can be a string or a content-block array
// (text, image_url, etc. — used for multi-modal input). Preserve it through
// to InvokeMessage so the provider routes can translate properly. Stringifying
// destroys image attachments — `String([{...}, {...}])` becomes "[object Object],..."
function lcContentToInvoke(content: BaseMessage["content"]): string | ContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: ContentPart[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push({ type: "text", text: block });
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image_url") {
      // OpenAI-style: { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
      const url = (b.image_url as { url?: string } | string | undefined);
      const dataUrl = typeof url === "string" ? url : url?.url;
      if (dataUrl?.startsWith("data:")) {
        const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
        if (m) parts.push({ type: "image", media_type: m[1], data: m[2] });
      }
    } else if (b.type === "image") {
      // Anthropic-style: { type: "image", source: { type: "base64", media_type, data } }
      const src = b.source as { media_type?: string; data?: string } | undefined;
      if (src?.media_type && src.data) {
        parts.push({ type: "image", media_type: src.media_type, data: src.data });
      }
    }
  }
  // If we ended up with only text blocks, collapse to a string so providers
  // that don't need multi-modal handling don't have to special-case.
  if (parts.every((p) => p.type === "text")) {
    return parts.map((p) => (p as { text: string }).text).join("\n");
  }
  return parts;
}

function toInvokeMessages(messages: BaseMessage[]): InvokeMessage[] {
  return messages.map((m): InvokeMessage => {
    if (isHumanMessage(m)) {
      return { role: "user", content: lcContentToInvoke(m.content) };
    }
    if (isSystemMessage(m)) {
      return { role: "system", content: lcContentToInvoke(m.content) };
    }
    if (isAIMessage(m)) {
      const ai = m as AIMessage;
      const invokeMsg: InvokeMessage = {
        role: "assistant",
        content: typeof m.content === "string" ? m.content : lcContentToInvoke(m.content),
      };
      if (ai.tool_calls?.length) {
        invokeMsg.tool_calls = ai.tool_calls.map((tc) => ({
          id: tc.id ?? "",
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        }));
      }
      return invokeMsg;
    }
    if (isToolMessage(m)) {
      return {
        role: "tool",
        content: typeof m.content === "string" ? m.content : lcContentToInvoke(m.content),
        tool_call_id: m.tool_call_id,
      };
    }
    return { role: "user", content: lcContentToInvoke(m.content) };
  });
}
