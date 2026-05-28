import { makeOpenAICompatProvider } from "./openai";
import { readSSELines } from "./streaming";
import type { ContentPart, InvokeMessage, InvokeResult, OpenAITool } from "@/lib/tools/types";
import type { ModelProvider, ProviderMessage, ProviderParams, ProviderStreamEvent, ProviderStreamResult } from "./types";

// Google Gemini via its OpenAI-compatible endpoint.
// Auth: set params.api_key to your Google AI Studio API key.
// Models: gemini-2.0-flash, gemini-2.5-pro, gemini-1.5-flash, etc.
const geminiCompat = makeOpenAICompatProvider(
  "gemini",
  "https://generativelanguage.googleapis.com/v1beta/openai/",
  {},
);

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

function useCompat(params: ProviderParams): boolean {
  return (params as Record<string, unknown>).gemini_use_openai_compat === true;
}

function nativeBaseUrl(params: ProviderParams): string {
  const raw = (params as Record<string, unknown>).gemini_native_base_url;
  if (typeof raw === "string" && raw.trim()) return raw.trim().replace(/\/+$/, "");
  return "https://generativelanguage.googleapis.com/v1beta";
}

function geminiApiKey(params: ProviderParams): string {
  const key = typeof params.api_key === "string" ? params.api_key : process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Gemini: no api_key configured");
  return key;
}

function contentToGeminiParts(content: string | ContentPart[]): GeminiPart[] {
  if (typeof content === "string") return [{ text: content }];
  const parts: GeminiPart[] = [];
  for (const p of content) {
    if (p.type === "text") {
      parts.push({ text: p.text });
      continue;
    }
    if (p.type === "image") {
      parts.push({ inlineData: { mimeType: p.media_type, data: p.data } });
      continue;
    }
    // Files map to inlineData when possible; otherwise tool-agnostic text fallback.
    if (p.type === "file") {
      if (p.media_type && p.data) {
        parts.push({ inlineData: { mimeType: p.media_type, data: p.data } });
      } else {
        parts.push({ text: `[File: ${p.name}]` });
      }
    }
  }
  return parts.length > 0 ? parts : [{ text: "" }];
}

function parseJsonObject(v: string | undefined): Record<string, unknown> {
  if (!v) return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return {};
  }
}

function providerMessagesToGemini(messages: ProviderMessage[]): {
  systemInstruction?: { parts: GeminiPart[] };
  contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }>;
} {
  const system = messages.find((m) => m.role === "system");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: (m.role === "assistant" ? "model" : "user") as "user" | "model",
      parts: [{ text: m.content } as GeminiPart],
    }));
  return {
    systemInstruction: system ? { parts: [{ text: system.content }] } : undefined,
    contents,
  };
}

function invokeMessagesToGemini(messages: InvokeMessage[]): {
  systemInstruction?: { parts: GeminiPart[] };
  contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }>;
} {
  const toolNameById = new Map<string, string>();
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
  let systemInstruction: { parts: GeminiPart[] } | undefined;

  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : contentToGeminiParts(m.content)
        .flatMap((p) => ("text" in p ? [p.text] : []))
        .join("\n");
      if (text.trim()) systemInstruction = { parts: [{ text }] };
      continue;
    }

    if (m.role === "assistant") {
      const parts = contentToGeminiParts(m.content);
      for (const tc of m.tool_calls ?? []) {
        const name = tc.function?.name ?? "tool";
        if (tc.id) toolNameById.set(tc.id, name);
        parts.push({ functionCall: { name, args: parseJsonObject(tc.function?.arguments) } });
      }
      contents.push({ role: "model", parts });
      continue;
    }

    if (m.role === "tool") {
      const name = m.tool_call_id ? toolNameById.get(m.tool_call_id) ?? "tool" : "tool";
      const raw = typeof m.content === "string" ? m.content : "";
      const response = parseJsonObject(raw);
      if (Object.keys(response).length === 0 && raw) response.content = raw;
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response } }],
      });
      continue;
    }

    contents.push({ role: "user", parts: contentToGeminiParts(m.content) });
  }

  return { systemInstruction, contents };
}

function toGeminiTools(tools: OpenAITool[], params: ProviderParams): unknown[] | undefined {
  const out: unknown[] = [];
  if (tools.length > 0) {
    out.push({
      functionDeclarations: tools
        .filter((t) => t.function?.name)
        .map((t) => ({
          name: t.function.name,
          description: t.function.description ?? "",
          parameters: t.function.parameters,
        })),
    });
  }
  const builtins = (params as Record<string, unknown>).gemini_builtin_tools;
  if (Array.isArray(builtins)) {
    for (const t of builtins) {
      if (t && typeof t === "object") out.push(t);
    }
  }
  return out.length > 0 ? out : undefined;
}

function toGenerationConfig(params: ProviderParams): Record<string, unknown> | undefined {
  const p = params as Record<string, unknown>;
  const base: Record<string, unknown> = {};
  if (params.temperature !== undefined) base.temperature = params.temperature;
  if (params.max_tokens !== undefined) base.maxOutputTokens = params.max_tokens;
  if (p.top_p !== undefined) base.topP = p.top_p;
  if (p.top_k !== undefined) base.topK = p.top_k;
  if (Array.isArray(p.stop)) base.stopSequences = p.stop;
  const rf = p.response_format as Record<string, unknown> | undefined;
  if (rf?.type === "json_object") {
    base.responseMimeType = "application/json";
  }
  if (typeof p.gemini_response_mime_type === "string") {
    base.responseMimeType = p.gemini_response_mime_type;
  }
  if (p.gemini_response_schema && typeof p.gemini_response_schema === "object") {
    base.responseSchema = p.gemini_response_schema;
    if (!base.responseMimeType) base.responseMimeType = "application/json";
  }
  if (p.gemini_thinking_config && typeof p.gemini_thinking_config === "object") {
    base.thinkingConfig = p.gemini_thinking_config;
  }
  const merged = p.gemini_generation_config && typeof p.gemini_generation_config === "object"
    ? { ...base, ...(p.gemini_generation_config as Record<string, unknown>) }
    : base;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function geminiNativeGenerate(
  model_id: string,
  body: Record<string, unknown>,
  params: ProviderParams,
): Promise<Record<string, unknown>> {
  const apiKey = geminiApiKey(params);
  const res = await fetch(
    `${nativeBaseUrl(params)}/models/${encodeURIComponent(model_id)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini generateContent error: ${res.status} ${msg}`);
  }
  return await res.json() as Record<string, unknown>;
}

function mapGeminiStopReason(reason: string | undefined): "stop" | "tool_use" | "length" {
  if (reason === "MAX_TOKENS") return "length";
  return "stop";
}

function extractGeminiInvokeResult(data: Record<string, unknown>): InvokeResult {
  const candidates = (data.candidates as Array<Record<string, unknown>> | undefined) ?? [];
  const first = candidates[0] ?? {};
  const content = (first.content as Record<string, unknown> | undefined) ?? {};
  const parts = (content.parts as Array<Record<string, unknown>> | undefined) ?? [];

  let text = "";
  const tool_calls: InvokeResult["tool_calls"] = [];
  for (const part of parts) {
    if (typeof part.text === "string") text += part.text;
    if (part.functionCall && typeof part.functionCall === "object") {
      const fc = part.functionCall as Record<string, unknown>;
      const name = typeof fc.name === "string" ? fc.name : "tool";
      const args = fc.args && typeof fc.args === "object" ? fc.args as Record<string, unknown> : {};
      tool_calls.push({
        id: typeof fc.id === "string" ? fc.id : `call_${tool_calls.length + 1}`,
        name,
        arguments: args,
      });
    }
  }

  const finishReason = typeof first.finishReason === "string" ? first.finishReason : undefined;
  return {
    text: text || null,
    tool_calls,
    stop_reason: tool_calls.length > 0 ? "tool_use" : mapGeminiStopReason(finishReason),
  };
}

async function* geminiNativeStreamInvoke(
  model_id: string,
  messages: InvokeMessage[],
  params: ProviderParams,
  tools: OpenAITool[],
): AsyncIterable<ProviderStreamEvent> {
  const { systemInstruction, contents } = invokeMessagesToGemini(messages);
  const body: Record<string, unknown> = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(toGeminiTools(tools, params) ? { tools: toGeminiTools(tools, params) } : {}),
    ...(toGenerationConfig(params) ? { generationConfig: toGenerationConfig(params) } : {}),
  };
  const p = params as Record<string, unknown>;
  if (p.gemini_tool_config && typeof p.gemini_tool_config === "object") body.toolConfig = p.gemini_tool_config;
  if (Array.isArray(p.gemini_safety_settings)) body.safetySettings = p.gemini_safety_settings;

  const apiKey = geminiApiKey(params);
  const res = await fetch(
    `${nativeBaseUrl(params)}/models/${encodeURIComponent(model_id)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok || !res.body) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini streamGenerateContent error: ${res.status} ${msg}`);
  }

  for await (const line of readSSELines(res.body)) {
    if (!line || line === "[DONE]") continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const candidates = (data.candidates as Array<Record<string, unknown>> | undefined) ?? [];
    const first = candidates[0] ?? {};
    const content = (first.content as Record<string, unknown> | undefined) ?? {};
    const parts = (content.parts as Array<Record<string, unknown>> | undefined) ?? [];
    for (const part of parts) {
      const isThought = part.thought === true;
      if (typeof part.text === "string" && part.text) {
        if (isThought) {
          yield { type: "thinking", delta: part.text };
        } else {
          yield { type: "text", delta: part.text };
        }
      }
      if (part.functionCall && typeof part.functionCall === "object") {
        const fc = part.functionCall as Record<string, unknown>;
        const name = typeof fc.name === "string" ? fc.name : "tool";
        const args = fc.args && typeof fc.args === "object" ? fc.args as Record<string, unknown> : {};
        yield {
          type: "tool_call_chunk",
          index: 0,
          id: typeof fc.id === "string" ? fc.id : undefined,
          name,
          args_delta: JSON.stringify(args),
        };
      }
    }
    if (typeof first.finishReason === "string") {
      yield { type: "stop", reason: mapGeminiStopReason(first.finishReason) };
    }
  }
}

async function geminiNativeInvoke(
  model_id: string,
  messages: InvokeMessage[],
  params: ProviderParams,
  tools: OpenAITool[],
): Promise<InvokeResult> {
  const { systemInstruction, contents } = invokeMessagesToGemini(messages);
  const body: Record<string, unknown> = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(toGeminiTools(tools, params) ? { tools: toGeminiTools(tools, params) } : {}),
    ...(toGenerationConfig(params) ? { generationConfig: toGenerationConfig(params) } : {}),
  };
  const p = params as Record<string, unknown>;
  if (p.gemini_tool_config && typeof p.gemini_tool_config === "object") body.toolConfig = p.gemini_tool_config;
  if (Array.isArray(p.gemini_safety_settings)) body.safetySettings = p.gemini_safety_settings;
  const data = await geminiNativeGenerate(model_id, body, params);
  return extractGeminiInvokeResult(data);
}

async function geminiNativeChat(
  model_id: string,
  messages: ProviderMessage[],
  params: ProviderParams,
): Promise<ProviderStreamResult> {
  const { systemInstruction, contents } = providerMessagesToGemini(messages);
  const body: Record<string, unknown> = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(toGenerationConfig(params) ? { generationConfig: toGenerationConfig(params) } : {}),
  };
  const p = params as Record<string, unknown>;
  if (Array.isArray(p.gemini_safety_settings)) body.safetySettings = p.gemini_safety_settings;

  const apiKey = geminiApiKey(params);
  const res = await fetch(
    `${nativeBaseUrl(params)}/models/${encodeURIComponent(model_id)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok || !res.body) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini chat stream error: ${res.status} ${msg}`);
  }

  return {
    stream: (async function* () {
      for await (const line of readSSELines(res.body!)) {
        if (!line || line === "[DONE]") continue;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const candidates = (data.candidates as Array<Record<string, unknown>> | undefined) ?? [];
        const first = candidates[0] ?? {};
        const content = (first.content as Record<string, unknown> | undefined) ?? {};
        const parts = (content.parts as Array<Record<string, unknown>> | undefined) ?? [];
        for (const part of parts) {
          if (typeof part.text === "string" && part.text && part.thought !== true) {
            yield part.text;
          }
        }
      }
    })(),
  };
}

function resolveGeminiEmbeddingModel(model_id: string, params: ProviderParams): string {
  const overridden = (params as Record<string, unknown>).embedding_model_id;
  if (typeof overridden === "string" && overridden.trim()) return overridden.trim();
  // When chat model ids (gemini-*) are passed into embed(), switch to a
  // dedicated embedding model by default.
  if (/^gemini-/i.test(model_id)) return "text-embedding-004";
  return model_id;
}

async function geminiEmbed(model_id: string, inputs: string[], params: ProviderParams): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const apiKey = typeof params.api_key === "string" ? params.api_key : process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini: no api_key configured");

  const model = resolveGeminiEmbeddingModel(model_id, params);
  const body = {
    requests: inputs.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
    })),
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini embeddings error: ${res.status} ${msg}`);
  }
  const data = await res.json() as {
    embeddings?: Array<{ values?: number[] }>;
    error?: { message?: string };
  };
  if (data.error?.message) throw new Error(data.error.message);
  const vectors = (data.embeddings ?? []).map((e) => e.values ?? []);
  if (vectors.length !== inputs.length) {
    throw new Error(`Gemini embeddings returned ${vectors.length}/${inputs.length} vectors`);
  }
  return vectors;
}

export const geminiProvider: ModelProvider = {
  ...geminiCompat,
  async chat(model_id, messages, params): Promise<ProviderStreamResult> {
    if (useCompat(params)) return geminiCompat.chat(model_id, messages, params);
    try {
      return await geminiNativeChat(model_id, messages, params);
    } catch {
      return geminiCompat.chat(model_id, messages, params);
    }
  },

  async invoke(model_id, messages, params, tools): Promise<InvokeResult> {
    if (useCompat(params)) {
      if (!geminiCompat.invoke) throw new Error("Gemini compat provider has no invoke() implementation");
      return geminiCompat.invoke(model_id, messages, params, tools);
    }
    try {
      return await geminiNativeInvoke(model_id, messages, params, tools);
    } catch {
      if (!geminiCompat.invoke) throw new Error("Gemini compat provider has no invoke() implementation");
      return geminiCompat.invoke(model_id, messages, params, tools);
    }
  },

  streamInvoke(model_id, messages, params, tools): AsyncIterable<ProviderStreamEvent> {
    if (useCompat(params)) {
      if (!geminiCompat.streamInvoke) throw new Error("Gemini compat provider has no streamInvoke() implementation");
      return geminiCompat.streamInvoke(model_id, messages, params, tools);
    }
    return (async function* (): AsyncIterable<ProviderStreamEvent> {
      try {
        yield* geminiNativeStreamInvoke(model_id, messages, params, tools);
      } catch {
        if (!geminiCompat.streamInvoke) throw new Error("Gemini compat provider has no streamInvoke() implementation");
        yield* geminiCompat.streamInvoke(model_id, messages, params, tools);
      }
    })();
  },

  async embed(model_id, inputs, params): Promise<number[][]> {
    return geminiEmbed(model_id, inputs, params);
  },
};
