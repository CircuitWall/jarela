import { describe, expect, it } from "vitest";
import {
  StreamChunkSchema,
  SSEEventSchema,
  safeParseSSEEvent,
  safeParseStreamChunk,
} from "./stream-chunk-schema";

describe("StreamChunkSchema (server-internal envelope)", () => {
  it("accepts a well-formed text_delta", () => {
    const r = StreamChunkSchema.safeParse({
      type: "text_delta",
      data: { delta: "hello" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects payload mismatched to type", () => {
    const r = StreamChunkSchema.safeParse({
      type: "text_delta",
      data: { id: "x", name: "y", arguments: {} },
    });
    expect(r.success).toBe(false);
  });

  it("accepts done with optional usage + flags", () => {
    const r = StreamChunkSchema.safeParse({
      type: "done",
      data: {
        message_id: "abc",
        usage: { input_tokens: 1, output_tokens: 2, source: "provider" },
        provider: "openai",
        model_id: "gpt-x",
        model_config_name: null,
        aborted: false,
      },
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown type", () => {
    const r = StreamChunkSchema.safeParse({ type: "future_event", data: {} });
    expect(r.success).toBe(false);
  });

  it("safeParseStreamChunk returns null on mismatch", () => {
    expect(safeParseStreamChunk({ type: "nope" })).toBeNull();
    expect(safeParseStreamChunk(null)).toBeNull();
    expect(safeParseStreamChunk({ type: "tool_call", data: {} })).toBeNull();
  });
});

describe("SSEEventSchema (flat wire shape)", () => {
  it("accepts flat text_delta", () => {
    const r = safeParseSSEEvent({ type: "text_delta", delta: "hi" });
    expect(r).not.toBeNull();
    expect(r?.type).toBe("text_delta");
  });

  it("accepts flat tool_call with arguments record", () => {
    const r = safeParseSSEEvent({
      type: "tool_call",
      id: "t1",
      name: "fetch",
      arguments: { url: "https://example.com" },
    });
    expect(r).not.toBeNull();
  });

  it("accepts run_in_flight (server-only event)", () => {
    const r = safeParseSSEEvent({ type: "run_in_flight", thread_id: "abc" });
    expect(r).not.toBeNull();
  });

  it("returns null on unknown future event", () => {
    expect(safeParseSSEEvent({ type: "tier_warning", level: "high" })).toBeNull();
  });

  it("returns null on missing required field", () => {
    expect(safeParseSSEEvent({ type: "tool_result", id: "t1" })).toBeNull();
  });

  it("returns null on non-object input", () => {
    expect(safeParseSSEEvent("text")).toBeNull();
    expect(safeParseSSEEvent(42)).toBeNull();
    expect(safeParseSSEEvent(null)).toBeNull();
  });

  it("done event with minimal payload (only message_id)", () => {
    const r = safeParseSSEEvent({ type: "done", message_id: "x" });
    expect(r).not.toBeNull();
  });

  it("rejects done with malformed usage", () => {
    const r = SSEEventSchema.safeParse({
      type: "done",
      message_id: "x",
      usage: { input_tokens: "many" },
    });
    expect(r.success).toBe(false);
  });
});
