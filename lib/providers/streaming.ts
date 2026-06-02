import type { ProviderStreamEvent } from "./types";

/**
 * Threshold for the consecutive-parse-failure tripwire. When the same
 * stream emits this many malformed JSON lines back-to-back, we abort the
 * stream rather than continue silently dropping them. Provider regressions
 * (a quoted backslash that breaks every chunk; a content-encoding flap)
 * would otherwise produce a stream of zero events that ends in a clean
 * "done" — the user sees an empty assistant turn with no signal that
 * anything went wrong. Six is generous: we still tolerate occasional
 * keepalives, vendor-specific debug frames, etc.
 *
 * Override with JARELA_STREAM_PARSE_TRIPWIRE for emergency relaxation.
 */
function parseTripwireThreshold(): number {
  const raw = Number(process.env.JARELA_STREAM_PARSE_TRIPWIRE);
  return Number.isFinite(raw) && raw > 0 ? raw : 6;
}

export class ProviderStreamParseError extends Error {
  readonly code = "stream_parse_failures";
  readonly consecutiveFailures: number;
  readonly sample: string;
  constructor(consecutiveFailures: number, sample: string) {
    super(`provider stream emitted ${consecutiveFailures} consecutive malformed lines; aborting`);
    this.name = "ProviderStreamParseError";
    this.consecutiveFailures = consecutiveFailures;
    this.sample = sample;
  }
}

// Tracks consecutive JSON.parse failures inside a stream parser. Returns
// the parsed value on success (resetting the counter), or throws
// ProviderStreamParseError once `threshold` consecutive failures
// accumulate. The caller's `try { JSON.parse } catch { continue }` pattern
// stays intact for the single-failure case; the wrapper just trips the
// circuit-breaker when failures pile up.
function makeParseGuard<T>(threshold: number): (line: string) => T | null {
  let consecutive = 0;
  return (line: string): T | null => {
    try {
      const value = JSON.parse(line) as T;
      consecutive = 0;
      return value;
    } catch {
      consecutive += 1;
      if (consecutive >= threshold) {
        throw new ProviderStreamParseError(consecutive, line.slice(0, 200));
      }
      return null;
    }
  };
}

// Reads `data: ...` lines from an SSE response body.
export async function* readSSELines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) yield line.slice(6).trim();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Parses an Anthropic SSE stream into ProviderStreamEvents.
// Tracks per-block-index type so deltas route to the right event.
export async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<ProviderStreamEvent> {
  const blockType = new Map<number, "text" | "thinking" | "tool_use">();
  const guardedParse = makeParseGuard<AnthropicStreamEvent>(parseTripwireThreshold());

  for await (const line of readSSELines(body)) {
    if (!line || line === "[DONE]") continue;
    const event = guardedParse(line);
    if (!event) continue;

    if (event.type === "content_block_start" && event.content_block) {
      const cb = event.content_block;
      if (cb.type === "tool_use") {
        blockType.set(event.index, "tool_use");
        yield { type: "tool_call_chunk", index: event.index, id: cb.id, name: cb.name };
      } else if (cb.type === "thinking") {
        blockType.set(event.index, "thinking");
      } else {
        blockType.set(event.index, "text");
      }
    } else if (event.type === "content_block_delta" && event.delta) {
      const d = event.delta;
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
}

interface AnthropicStreamEvent {
  type: string;
  index: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
}

// Parses an OpenAI-style SSE stream (chat.completions with stream:true) into ProviderStreamEvents.
// Handles delta.content (text), delta.reasoning_content (DeepSeek thinking), delta.tool_calls fragments.
export async function* parseOpenAIStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<ProviderStreamEvent> {
  const guardedParse = makeParseGuard<OpenAIStreamEvent>(parseTripwireThreshold());
  for await (const line of readSSELines(body)) {
    if (!line || line === "[DONE]") continue;
    const event = guardedParse(line);
    if (!event) continue;

    const choice = event.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;

    if (delta?.content) {
      yield { type: "text", delta: delta.content };
    }
    if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
      yield { type: "thinking", delta: delta.reasoning_content };
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        yield {
          type: "tool_call_chunk",
          index: idx,
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

interface OpenAIStreamEvent {
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}
