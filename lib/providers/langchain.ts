/**
 * Bridge provider: wraps any LangChain `BaseChatModel` so that LangGUI's
 * `ModelProvider` interface can surface the entire LangChain ecosystem of
 * model integrations (Gemini, Bedrock, Cohere, Ollama-native, etc.) without
 * us writing a custom adapter for each one.
 *
 * Config (params on a `model_configs` row with `provider: "langchain"`):
 *   - lc_class: required. The exported class name to instantiate
 *               (e.g. "ChatGoogleGenerativeAI", "ChatCohere").
 *   - All other params are forwarded to the class constructor as-is, so any
 *     vendor-specific option (apiKey, region, projectId, ...) "just works".
 *
 * Adding a new LangChain integration:
 *   1. `npm install @langchain/<vendor>`
 *   2. Add a case to the `loadLangChainModel` switch below.
 *   3. Create a model_config: provider="langchain", model_id="<vendor's model id>",
 *      params={ lc_class: "ChatXxx", apiKey: "..." }.
 *
 * Why a switch instead of dynamic import("@langchain/" + vendor)? Next.js
 * bundles server code at build time; dynamic specifiers can't be statically
 * traced and the package wouldn't end up in the bundle. A small switch keeps
 * the bundling explicit and the dependency footprint visible.
 */
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Runnable } from "@langchain/core/runnables";
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

// ── Module-cached model instances ────────────────────────────────────────────
// LangChain model classes are usually cheap to construct, but caching keeps
// the proxy/HTTP-client setup amortized across requests.
const cache = new Map<string, BaseChatModel>();
function cacheKey(model_id: string, params: ProviderParams): string {
  return `${params.lc_class}:${model_id}:${JSON.stringify({ ...params, lc_class: undefined })}`;
}

async function loadLangChainModel(model_id: string, params: ProviderParams): Promise<BaseChatModel> {
  const k = cacheKey(model_id, params);
  const hit = cache.get(k);
  if (hit) return hit;

  const cls = params.lc_class as string | undefined;
  if (!cls) throw new Error(`langchain provider: params.lc_class is required (e.g. "ChatGoogleGenerativeAI")`);

  // Strip our control fields from the args we pass to the class constructor.
  const { lc_class: _ignore1, lc_module: _ignore2, ...ctorArgs } = params as Record<string, unknown>;
  void _ignore1; void _ignore2;
  // Convention: if the user puts `model_id` on the config row, forward it as
  // `model` to the class (LangChain's standard option name).
  const args: Record<string, unknown> = { ...ctorArgs, model: model_id };

  let model: BaseChatModel;
  switch (cls) {
    case "ChatGoogleGenerativeAI": {
      const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
      model = new ChatGoogleGenerativeAI(args as unknown as ConstructorParameters<typeof ChatGoogleGenerativeAI>[0]);
      break;
    }
    case "ChatCohere": {
      const { ChatCohere } = await import("@langchain/cohere");
      model = new ChatCohere(args as unknown as ConstructorParameters<typeof ChatCohere>[0]);
      break;
    }
    default:
      throw new Error(
        `langchain provider: unknown lc_class "${cls}". ` +
        `Supported: ChatGoogleGenerativeAI, ChatCohere. ` +
        `To add another, install @langchain/<vendor> and extend lib/providers/langchain.ts.`
      );
  }
  cache.set(k, model);
  return model;
}

// ── Message conversion ──────────────────────────────────────────────────────
function toLCMessages(messages: ProviderMessage[]): BaseMessage[] {
  return messages.map((m) => {
    if (m.role === "system") return new SystemMessage(m.content);
    if (m.role === "assistant") return new AIMessage(m.content);
    return new HumanMessage(m.content);
  });
}

function toLCInvokeMessages(messages: InvokeMessage[]): BaseMessage[] {
  return messages.map((m) => {
    if (m.role === "system") return new SystemMessage(typeof m.content === "string" ? m.content : "");
    if (m.role === "tool") {
      return new ToolMessage({
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        tool_call_id: m.tool_call_id ?? "",
      });
    }
    if (m.role === "assistant") {
      const ai = new AIMessage({
        content: typeof m.content === "string" ? m.content : "",
        tool_calls: m.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.function?.name ?? "",
          args: (() => { try { return JSON.parse(tc.function?.arguments ?? "{}"); } catch { return {}; } })(),
          type: "tool_call" as const,
        })) ?? [],
      });
      return ai;
    }
    return new HumanMessage(typeof m.content === "string" ? m.content : "");
  });
}

function toLCTools(tools: OpenAITool[]): Array<{ name: string; description: string; schema: unknown }> {
  return tools.flatMap((t) => {
    if (!t.function?.name) return [];
    return [{
      name: t.function.name,
      description: t.function.description ?? "",
      schema: t.function.parameters,
    }];
  });
}

// ── ModelProvider methods ───────────────────────────────────────────────────
export const langchainProvider: ModelProvider = {
  name: "langchain",

  async chat(model_id, messages, params): Promise<ProviderStreamResult> {
    const model = await loadLangChainModel(model_id, params);
    const stream = await model.stream(toLCMessages(messages));
    return {
      stream: (async function* () {
        for await (const chunk of stream) {
          if (typeof chunk.content === "string" && chunk.content) yield chunk.content;
        }
      })(),
    };
  },

  async invoke(model_id, messages, params, tools): Promise<InvokeResult> {
    const model = await loadLangChainModel(model_id, params);
    const bound: Runnable = tools.length > 0 && (model as { bindTools?: unknown }).bindTools
      ? (model as unknown as { bindTools: (t: unknown) => Runnable }).bindTools(toLCTools(tools))
      : model;
    const result = await bound.invoke(toLCInvokeMessages(messages)) as AIMessage;

    const text = typeof result.content === "string" ? result.content : extractText(result.content);
    const toolCalls = (result.tool_calls ?? []).map((tc) => ({
      id: tc.id ?? "",
      name: tc.name ?? "",
      arguments: (tc.args ?? {}) as Record<string, unknown>,
    }));
    return {
      text: text || null,
      tool_calls: toolCalls,
      stop_reason: toolCalls.length > 0 ? "tool_use" : "stop",
    };
  },

  streamInvoke(model_id, messages, params, tools): AsyncIterable<ProviderStreamEvent> {
    return (async function* () {
      const model = await loadLangChainModel(model_id, params);
      const bound: Runnable = tools.length > 0 && (model as { bindTools?: unknown }).bindTools
        ? (model as unknown as { bindTools: (t: unknown) => Runnable }).bindTools(toLCTools(tools))
        : model;

      const stream = await bound.stream(toLCInvokeMessages(messages)) as AsyncIterable<AIMessageChunk>;

      // Track which tool_call_chunk indices we've already announced an id for —
      // some providers send id once at start, others repeat it on every chunk.
      for await (const chunk of stream) {
        if (typeof chunk.content === "string" && chunk.content) {
          yield { type: "text", delta: chunk.content };
        } else if (Array.isArray(chunk.content)) {
          // Multi-modal content blocks (Gemini): pull text out, drop the rest.
          for (const block of chunk.content) {
            if (typeof block === "object" && block && "type" in block && block.type === "text" && "text" in block) {
              yield { type: "text", delta: String(block.text) };
            }
          }
        }
        const reasoning = chunk.additional_kwargs?.reasoning_content;
        if (typeof reasoning === "string" && reasoning) {
          yield { type: "thinking", delta: reasoning };
        }
        for (const tcc of chunk.tool_call_chunks ?? []) {
          yield {
            type: "tool_call_chunk",
            index: tcc.index ?? 0,
            id: tcc.id,
            name: tcc.name,
            args_delta: tcc.args,
          };
        }
      }
    })();
  },

  // Embeddings: LangChain has separate `Embeddings` classes per vendor and the
  // mapping isn't 1:1 with chat-model classes. Skipping here — recall falls
  // back to its substring path for langchain-provided models, which is fine.
};

function extractText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((b) => typeof b === "object" && b && (b as { type?: string }).type === "text")
      .map((b) => String((b as { text?: string }).text ?? ""))
      .join("");
  }
  return "";
}
