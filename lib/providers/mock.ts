// Mock/dummy model provider for tests, demos, and offline development.
//
// Behaviour is scripted via directives embedded in the *last user message*:
//
//   MOCK:reply=Hello world          // stream back exactly "Hello world"
//   MOCK:echo                       // echo the user message verbatim
//   MOCK:tool=web_search:{"q":"x"}  // emit one tool_call (id=mock-1, args = JSON)
//   MOCK:think=reasoning here       // emit a thinking delta before text
//   MOCK:slow=50                    // sleep 50ms between word chunks
//   MOCK:error=overloaded           // throw "overloaded"
//   MOCK:stop=length                // override stop_reason (default "stop")
//
// Multiple directives may appear on separate lines; everything else in the
// message is treated as plain context.
//
// Default behaviour (no directives): streams back "Hello from the mock
// provider. You said: <last user message>".
//
// Registration is gated by JARELA_ENABLE_MOCK_PROVIDER=1 in index.ts so the
// provider can't be accidentally enabled in production.

import { createHash } from "node:crypto";
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

const DEFAULT_REPLY = "Hello from the mock provider. You said: ";
const EMBED_DIM = 384;

export type MockDirectives = {
  reply?: string;
  echo?: boolean;
  tool?: { name: string; args: Record<string, unknown> };
  think?: string;
  slowMs?: number;
  error?: string;
  stopReason?: "stop" | "tool_use" | "length";
};

/** Parse `MOCK:<key>[=<value>]` directives out of a message string. Exported
 *  for unit tests. */
export function parseMockDirectives(text: string): MockDirectives {
  const out: MockDirectives = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*MOCK:([a-zA-Z]+)(?:=(.*))?\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2] ?? "";
    switch (key) {
      case "reply":
        out.reply = value;
        break;
      case "echo":
        out.echo = true;
        break;
      case "tool": {
        // tool=<name>[:<json-args>]
        const colon = value.indexOf(":");
        if (colon === -1) {
          out.tool = { name: value, args: {} };
        } else {
          const name = value.slice(0, colon);
          const argsRaw = value.slice(colon + 1);
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(argsRaw) as Record<string, unknown>; } catch { /* leave empty */ }
          out.tool = { name, args };
        }
        break;
      }
      case "think":
        out.think = value;
        break;
      case "slow": {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) out.slowMs = n;
        break;
      }
      case "error":
        out.error = value || "mock error";
        break;
      case "stop":
        if (value === "stop" || value === "tool_use" || value === "length") out.stopReason = value;
        break;
    }
  }
  return out;
}

function lastUserText(messages: { role: string; content: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const parts = m.content as { type: string; text?: string }[];
      return parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
    }
    return "";
  }
  return "";
}

function pickReply(directives: MockDirectives, userText: string): string {
  if (directives.reply !== undefined) return directives.reply;
  if (directives.echo) return userText;
  return DEFAULT_REPLY + userText;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tokenize(text: string): string[] {
  // Split into whitespace-preserving chunks so the streaming feels real and
  // round-trips through the UI's incremental rendering.
  return text.match(/\S+\s*|\s+/g) ?? (text ? [text] : []);
}

async function* streamText(text: string, slowMs?: number): AsyncIterable<string> {
  for (const chunk of tokenize(text)) {
    if (slowMs) await sleep(slowMs);
    yield chunk;
  }
}

export const mockProvider: ModelProvider = {
  name: "mock",

  async chat(_model_id, messages, _params: ProviderParams): Promise<ProviderStreamResult> {
    const userText = lastUserText(messages as ProviderMessage[]);
    const directives = parseMockDirectives(userText);
    if (directives.error) throw new Error(directives.error);
    const reply = pickReply(directives, userText);
    return {
      stream: streamText(reply, directives.slowMs),
    };
  },

  async invoke(_model_id, messages, _params, _tools: OpenAITool[]): Promise<InvokeResult> {
    const userText = lastUserText(messages as InvokeMessage[]);
    const directives = parseMockDirectives(userText);
    if (directives.error) throw new Error(directives.error);

    if (directives.tool) {
      return {
        text: null,
        tool_calls: [{
          id: "mock-1",
          name: directives.tool.name,
          arguments: directives.tool.args,
        }],
        stop_reason: "tool_use",
      };
    }
    return {
      text: pickReply(directives, userText),
      tool_calls: [],
      stop_reason: directives.stopReason ?? "stop",
    };
  },

  async *streamInvoke(
    _model_id,
    messages,
    _params,
    _tools: OpenAITool[],
  ): AsyncIterable<ProviderStreamEvent> {
    const userText = lastUserText(messages as InvokeMessage[]);
    const directives = parseMockDirectives(userText);
    if (directives.error) throw new Error(directives.error);

    if (directives.think) {
      for (const chunk of tokenize(directives.think)) {
        if (directives.slowMs) await sleep(directives.slowMs);
        yield { type: "thinking", delta: chunk };
      }
    }

    if (directives.tool) {
      const argsJson = JSON.stringify(directives.tool.args);
      yield { type: "tool_call_chunk", index: 0, id: "mock-1", name: directives.tool.name };
      yield { type: "tool_call_chunk", index: 0, args_delta: argsJson };
      yield { type: "stop", reason: "tool_use" };
      return;
    }

    const reply = pickReply(directives, userText);
    for (const chunk of tokenize(reply)) {
      if (directives.slowMs) await sleep(directives.slowMs);
      yield { type: "text", delta: chunk };
    }
    yield { type: "stop", reason: directives.stopReason ?? "stop" };
  },

  async embed(_model_id, inputs, _params): Promise<number[][]> {
    // Deterministic per-input vector seeded by sha256 of the input. Same
    // input always produces the same vector so semantic-recall tests can
    // assert stable rankings.
    return inputs.map((input) => {
      const hash = createHash("sha256").update(input).digest();
      const vec = new Array<number>(EMBED_DIM);
      for (let i = 0; i < EMBED_DIM; i++) {
        // Repeat the 32-byte digest to fill EMBED_DIM. Map [0,255] -> [-1,1].
        vec[i] = (hash[i % hash.length] / 127.5) - 1;
      }
      // L2-normalise so cosine == dot product.
      let norm = 0;
      for (const x of vec) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
      return vec;
    });
  },
};
