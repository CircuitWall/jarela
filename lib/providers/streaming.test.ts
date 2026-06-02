import { describe, it, expect } from "vitest";
import {
  parseAnthropicStream,
  parseOpenAIStream,
  ProviderStreamParseError,
} from "./streaming";

function bodyFromLines(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(`${line}\n`));
      controller.close();
    },
  });
}

describe("parseAnthropicStream parse-failure tripwire", () => {
  it("tolerates an occasional malformed line", async () => {
    process.env.JARELA_STREAM_PARSE_TRIPWIRE = "5";
    const body = bodyFromLines([
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}`,
      `data: garbage-not-json`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
    ]);
    const events = [];
    for await (const e of parseAnthropicStream(body)) events.push(e);
    // The garbage line is dropped; the text delta still lands.
    expect(events.some((e) => e.type === "text" && e.delta === "hi")).toBe(true);
    delete process.env.JARELA_STREAM_PARSE_TRIPWIRE;
  });

  it("throws ProviderStreamParseError after the configured threshold of consecutive failures", async () => {
    process.env.JARELA_STREAM_PARSE_TRIPWIRE = "3";
    const body = bodyFromLines([
      `data: bad-1`,
      `data: bad-2`,
      `data: bad-3`,
    ]);
    let captured: unknown = null;
    try {
      for await (const _e of parseAnthropicStream(body)) {
        // body
      }
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderStreamParseError);
    expect((captured as ProviderStreamParseError).consecutiveFailures).toBeGreaterThanOrEqual(3);
    delete process.env.JARELA_STREAM_PARSE_TRIPWIRE;
  });

  it("resets the counter on a successful parse", async () => {
    process.env.JARELA_STREAM_PARSE_TRIPWIRE = "3";
    const body = bodyFromLines([
      `data: bad-1`,
      `data: bad-2`,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}`,
      `data: bad-3`,
      `data: bad-4`,
      // Two more bad would have tripped; one more good resets again.
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}`,
    ]);
    const events = [];
    for await (const e of parseAnthropicStream(body)) events.push(e);
    expect(events.some((e) => e.type === "text")).toBe(true);
    delete process.env.JARELA_STREAM_PARSE_TRIPWIRE;
  });
});

describe("parseOpenAIStream parse-failure tripwire", () => {
  it("throws ProviderStreamParseError after threshold consecutive failures", async () => {
    process.env.JARELA_STREAM_PARSE_TRIPWIRE = "2";
    const body = bodyFromLines([`data: nope`, `data: also-nope`]);
    await expect(async () => {
      for await (const _e of parseOpenAIStream(body)) {
        // body
      }
    }).rejects.toBeInstanceOf(ProviderStreamParseError);
    delete process.env.JARELA_STREAM_PARSE_TRIPWIRE;
  });

  it("yields events from valid lines and skips occasional bad ones", async () => {
    process.env.JARELA_STREAM_PARSE_TRIPWIRE = "5";
    const body = bodyFromLines([
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}`,
      `data: junk`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
    ]);
    const events = [];
    for await (const e of parseOpenAIStream(body)) events.push(e);
    expect(events).toContainEqual({ type: "text", delta: "hi" });
    expect(events.some((e) => e.type === "stop")).toBe(true);
    delete process.env.JARELA_STREAM_PARSE_TRIPWIRE;
  });
});
