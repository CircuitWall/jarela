import { makeOpenAICompatProvider } from "./openai";
import { resolveProviderApiKey } from "./credentials";
import { readSSELines } from "./streaming";
import { ProviderAuthError, isAuthHttpStatus } from "./errors";
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
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args?: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

function isCompatMode(params: ProviderParams): boolean {
  return (params as Record<string, unknown>).gemini_use_openai_compat === true;
}

function nativeBaseUrl(params: ProviderParams): string {
  const raw = (params as Record<string, unknown>).gemini_native_base_url;
  if (typeof raw === "string" && raw.trim()) return raw.trim().replace(/\/+$/, "");
  return "https://generativelanguage.googleapis.com/v1beta";
}

// Bare-fetch calls below have no SDK-level timeout, so a dropped connection
// or a Google upstream hanging mid-stream would block the request forever
// (and pin the agent run until its idle/max timeout aborts it). Cap each
// fetch at 10 min by default, matching the implicit ceilings the official
// OpenAI / Anthropic SDKs already enforce.
const NATIVE_FETCH_TIMEOUT_MS = 10 * 60 * 1000;
function nativeFetchSignal(): AbortSignal {
  return AbortSignal.timeout(NATIVE_FETCH_TIMEOUT_MS);
}

function geminiApiKey(params: ProviderParams): string {
  const key = resolveProviderApiKey("gemini", params);
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
    if (p.type === "image_ref") {
      // See ADR-0065. Refs are normally unwrapped by `toBaseMessages` in
      // `lib/agents/llm.ts` before providers see them; this is a defensive
      // fallback for any caller that bypasses that path.
      parts.push({ text: `[image attachment: ${p.media_type}]` });
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
      parts: contentToGeminiParts(m.content),
    }));
  return {
    systemInstruction: system ? { parts: contentToGeminiParts(system.content) } : undefined,
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
        // Reattach the thoughtSignature Gemini emitted on the original
        // response part — required on every functionCall replayed once the
        // model started using thinking, else Gemini 400s with
        // "Function call is missing a thought_signature in functionCall parts".
        const sig = typeof tc.provider_meta?.gemini_thought_signature === "string"
          ? tc.provider_meta.gemini_thought_signature
          : undefined;
        const fcPart: GeminiPart = {
          functionCall: { name, args: parseJsonObject(tc.function?.arguments) },
        };
        if (sig) fcPart.thoughtSignature = sig;
        parts.push(fcPart);
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

// Gemini's tool-schema endpoint accepts only the OpenAPI 3.0 subset documented
// at https://ai.google.dev/api/caching#Schema. Zod 4 emits JSON Schema 2020-12
// with `$schema`, `additionalProperties`, numeric `exclusiveMinimum`, and
// `propertyNames` — Gemini rejects every unknown key with HTTP 400. Whitelist
// the accepted keys (recursively) and translate numeric exclusiveMinimum /
// exclusiveMaximum into plain `minimum` / `maximum` so range hints survive.
const GEMINI_SCHEMA_KEYS = new Set([
  "type", "format", "description", "nullable", "enum", "items", "properties",
  "required", "minimum", "maximum", "minItems", "maxItems", "minLength",
  "maxLength", "pattern", "example", "default", "anyOf", "propertyOrdering",
  "title",
]);

function sanitizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGeminiSchema);
  if (!value || typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "exclusiveMinimum" && typeof v === "number") {
      if (out.minimum === undefined) out.minimum = v;
      continue;
    }
    if (k === "exclusiveMaximum" && typeof v === "number") {
      if (out.maximum === undefined) out.maximum = v;
      continue;
    }
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = sanitizeGeminiSchema(pv);
      }
      out[k] = props;
    } else if (k === "items" || k === "anyOf") {
      out[k] = sanitizeGeminiSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
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
          parameters: sanitizeGeminiSchema(t.function.parameters),
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
      signal: nativeFetchSignal(),
    },
  );
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    // 400 with API_KEY_INVALID is the Google-specific auth-fail shape; the
    // rest of the auth status set is the standard 401/403.
    if (isAuthHttpStatus(res.status) || /API_KEY_INVALID/i.test(msg)) {
      throw new ProviderAuthError("gemini", `Gemini generateContent auth error: ${res.status} ${msg}`, res.status);
    }
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
  let pendingThoughtSignature: string | undefined;
  for (const part of parts) {
    if (typeof part.text === "string") text += part.text;
    if (part.thought === true && typeof part.thoughtSignature === "string") {
      pendingThoughtSignature = part.thoughtSignature;
    }
    if (part.functionCall && typeof part.functionCall === "object") {
      const fc = part.functionCall as Record<string, unknown>;
      const name = typeof fc.name === "string" ? fc.name : "tool";
      const args = fc.args && typeof fc.args === "object" ? fc.args as Record<string, unknown> : {};
      const partSig = typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;
      const sig = partSig ?? pendingThoughtSignature;
      pendingThoughtSignature = undefined;
      tool_calls.push({
        id: typeof fc.id === "string" ? fc.id : `call_${tool_calls.length + 1}`,
        name,
        arguments: args,
        ...(sig ? { provider_meta: { gemini_thought_signature: sig } } : {}),
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
      signal: nativeFetchSignal(),
    },
  );
  if (!res.ok || !res.body) {
    const msg = await res.text().catch(() => res.statusText);
    if (isAuthHttpStatus(res.status) || /API_KEY_INVALID/i.test(msg)) {
      throw new ProviderAuthError("gemini", `Gemini streamGenerateContent auth error: ${res.status} ${msg}`, res.status);
    }
    throw new Error(`Gemini streamGenerateContent error: ${res.status} ${msg}`);
  }

  let functionCallIndex = 0;
  // Gemini attaches `thoughtSignature` to the thinking-summary part, and
  // the subsequent functionCall must carry it on replay. When the model
  // emits multiple thought summaries in a single response, keep only the
  // most recent one — the API pairs each functionCall with the sig from
  // the thought block that immediately preceded it.
  let pendingThoughtSignature: string | undefined;
  // usageMetadata in each SSE chunk is a running total, not a delta —
  // capture only the last value and emit it once after the stream ends.
  let lastUsageMetadata: Record<string, number> | null = null;
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
    const um = data.usageMetadata as Record<string, number> | undefined;
    if (um) lastUsageMetadata = um;
    for (const part of parts) {
      const isThought = part.thought === true;
      const partSig = typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;
      if (typeof part.text === "string" && part.text) {
        if (isThought) {
          if (partSig) pendingThoughtSignature = partSig;
          yield { type: "thinking", delta: part.text };
        } else {
          yield { type: "text", delta: part.text };
        }
      }
      if (part.functionCall && typeof part.functionCall === "object") {
        const fc = part.functionCall as Record<string, unknown>;
        const name = typeof fc.name === "string" ? fc.name : "tool";
        const args = fc.args && typeof fc.args === "object" ? fc.args as Record<string, unknown> : {};
        const index = functionCallIndex++;
        const id = typeof fc.id === "string" ? fc.id : `gemini_fc_${index}`;
        const sig = partSig ?? pendingThoughtSignature;
        // Consumed the signature; a subsequent functionCall in the same
        // stream needs its own preceding thought part to supply a new one.
        pendingThoughtSignature = undefined;
        yield {
          type: "tool_call_chunk",
          index,
          id,
          name,
          args_delta: JSON.stringify(args),
          ...(sig ? { provider_meta: { gemini_thought_signature: sig } } : {}),
        };
      }
    }
    if (typeof first.finishReason === "string") {
      yield { type: "stop", reason: mapGeminiStopReason(first.finishReason) };
    }
  }
  // Emit a single normalised usage event using the final cumulative totals.
  if (lastUsageMetadata) {
    yield {
      type: "usage",
      input_tokens: lastUsageMetadata.promptTokenCount ?? 0,
      // thinking tokens bill at output rate and are separate from candidatesTokenCount
      output_tokens: (lastUsageMetadata.candidatesTokenCount ?? 0) + (lastUsageMetadata.thoughtsTokenCount ?? 0),
      total_tokens: lastUsageMetadata.totalTokenCount,
      cache_read_input_tokens: lastUsageMetadata.cachedContentTokenCount || undefined,
      thinking_tokens: lastUsageMetadata.thoughtsTokenCount || undefined,
    };
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
      signal: nativeFetchSignal(),
    },
  );
  if (!res.ok || !res.body) {
    const msg = await res.text().catch(() => res.statusText);
    if (isAuthHttpStatus(res.status) || /API_KEY_INVALID/i.test(msg)) {
      throw new ProviderAuthError("gemini", `Gemini chat stream auth error: ${res.status} ${msg}`, res.status);
    }
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
  const apiKey = geminiApiKey(params);

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
      signal: nativeFetchSignal(),
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
    if (isCompatMode(params)) return geminiCompat.chat(model_id, messages, params);
    try {
      return await geminiNativeChat(model_id, messages, params);
    } catch (err) {
      // Auth failures use the SAME api_key on both endpoints — falling
      // back to compat will fail the same way and mask the real cause
      // (ADR-0068). Re-throw so the runtime can surface a targeted
      // "credential invalid" banner deep-linking to /settings/credentials.
      if (err instanceof ProviderAuthError) throw err;
      console.warn("[gemini] native chat failed, falling back to OpenAI-compat:", err);
      return geminiCompat.chat(model_id, messages, params);
    }
  },

  async invoke(model_id, messages, params, tools): Promise<InvokeResult> {
    if (isCompatMode(params)) {
      if (!geminiCompat.invoke) throw new Error("Gemini compat provider has no invoke() implementation");
      return geminiCompat.invoke(model_id, messages, params, tools);
    }
    try {
      return await geminiNativeInvoke(model_id, messages, params, tools);
    } catch (err) {
      if (err instanceof ProviderAuthError) throw err;
      console.warn("[gemini] native invoke failed, falling back to OpenAI-compat:", err);
      if (!geminiCompat.invoke) throw new Error("Gemini compat provider has no invoke() implementation");
      return geminiCompat.invoke(model_id, messages, params, tools);
    }
  },

  streamInvoke(model_id, messages, params, tools): AsyncIterable<ProviderStreamEvent> {
    if (isCompatMode(params)) {
      if (!geminiCompat.streamInvoke) throw new Error("Gemini compat provider has no streamInvoke() implementation");
      return geminiCompat.streamInvoke(model_id, messages, params, tools);
    }
    return (async function* (): AsyncIterable<ProviderStreamEvent> {
      try {
        yield* geminiNativeStreamInvoke(model_id, messages, params, tools);
      } catch (err) {
        if (err instanceof ProviderAuthError) throw err;
        console.warn("[gemini] native streamInvoke failed, falling back to OpenAI-compat:", err);
        if (!geminiCompat.streamInvoke) throw new Error("Gemini compat provider has no streamInvoke() implementation");
        yield* geminiCompat.streamInvoke(model_id, messages, params, tools);
      }
    })();
  },

  async embed(model_id, inputs, params): Promise<number[][]> {
    return geminiEmbed(model_id, inputs, params);
  },
};
