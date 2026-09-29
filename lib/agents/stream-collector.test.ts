import { describe, expect, it } from "vitest";
import { collectStream } from "./stream-collector";
import type { StreamChunk } from "./base";

async function* fromArray(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const c of chunks) yield c;
}

describe("collectStream", () => {
  it("accumulates text_delta and returns terminal=done", async () => {
    const out = await collectStream(fromArray([
      { type: "text_delta", data: { delta: "Hello " } },
      { type: "text_delta", data: { delta: "world" } },
      { type: "done", data: {} },
    ]));
    expect(out.terminal).toBe("done");
    expect(out.assistantContent).toBe("Hello world");
    expect(out.aborted).toBeUndefined();
  });

  it("flags aborted=true when error chunk carries code=aborted", async () => {
    const out = await collectStream(fromArray([
      { type: "text_delta", data: { delta: "I was about to" } },
      { type: "error", data: { message: "Run interrupted by user.", code: "aborted" } },
    ]));
    expect(out.terminal).toBe("error");
    expect(out.aborted).toBe(true);
    expect(out.assistantContent).toBe("I was about to");
    expect(out.errorMessage).toBe("Run interrupted by user.");
  });

  it("leaves aborted unset on generic stream errors", async () => {
    const out = await collectStream(fromArray([
      { type: "text_delta", data: { delta: "partial" } },
      { type: "error", data: { message: "model 500", code: "upstream_error" } },
    ]));
    expect(out.terminal).toBe("error");
    expect(out.aborted).toBeUndefined();
  });

  // Issue #576: the output-validator retry emits "reset_text" to discard a
  // flagged reply before the retry's own text streams in. This is the
  // single unified collector (see file header) that feeds both the DB
  // persistence path and — via the same chunk sequence — the live client
  // buffer, so this covers the fix at the shared root.
  it("clears the accumulated text on reset_text, keeping only what follows", async () => {
    const out = await collectStream(fromArray([
      { type: "text_delta", data: { delta: "flagged reply" } },
      { type: "reset_text", data: {} },
      { type: "text_delta", data: { delta: "corrected reply" } },
      { type: "done", data: {} },
    ]));
    expect(out.terminal).toBe("done");
    expect(out.assistantContent).toBe("corrected reply");
  });

  it("flags aborted=true when the iterator throws an AbortError", async () => {
    async function* throwing(): AsyncIterable<StreamChunk> {
      yield { type: "text_delta", data: { delta: "partial" } };
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    const out = await collectStream(throwing());
    expect(out.terminal).toBe("error");
    expect(out.aborted).toBe(true);
    expect(out.assistantContent).toBe("partial");
  });

  // invoke_tool is registered as `execute` capability (lib/tools/system/invoke-tool.ts),
  // so leaving `usedTools` as the literal wrapper name "invoke_tool" makes
  // persistAssistantMessage's stall/fabrication checks (isWriteLikeToolName)
  // treat EVERY proxied call as a successful write, regardless of the actual
  // target tool's capability or whether the call was rejected/errored.
  describe("usedTools unwraps invoke_tool dispatches to the target tool", () => {
    it("records the target tool name, not the invoke_tool wrapper, for a successful proxied call", async () => {
      const out = await collectStream(fromArray([
        {
          type: "tool_call",
          data: { id: "call-1", name: "invoke_tool", arguments: { name: "memory_write", args_json: "{}" } },
        },
        {
          type: "tool_result",
          data: {
            id: "call-1",
            name: "invoke_tool",
            result: { ok: true, tool: "memory_write", status: "done", result: {} },
          },
        },
        { type: "done", data: {} },
      ]));
      expect(out.usedTools).toEqual(["memory_write"]);
    });

    it("excludes a rejected proxied call from usedTools — nothing was actually done under that name", async () => {
      const out = await collectStream(fromArray([
        {
          type: "tool_call",
          data: { id: "call-1", name: "invoke_tool", arguments: { name: "memory_write", args_json: "not json" } },
        },
        {
          type: "tool_result",
          data: {
            id: "call-1",
            name: "invoke_tool",
            result: { ok: false, tool: "memory_write", status: "rejected", error: "bad_args_json" },
          },
        },
        { type: "done", data: {} },
      ]));
      expect(out.usedTools).toEqual([]);
    });

    it("excludes an errored proxied call from usedTools", async () => {
      const out = await collectStream(fromArray([
        {
          type: "tool_call",
          data: { id: "call-1", name: "invoke_tool", arguments: { name: "file_write", args_json: "{}" } },
        },
        {
          type: "tool_result",
          data: {
            id: "call-1",
            name: "invoke_tool",
            result: { ok: false, tool: "file_write", status: "error", error: "disk full" },
          },
        },
        { type: "done", data: {} },
      ]));
      expect(out.usedTools).toEqual([]);
    });

    it("still includes a proxied call with no matching result yet (e.g. run aborted mid-call) — fails open, not closed", async () => {
      const out = await collectStream(fromArray([
        {
          type: "tool_call",
          data: { id: "call-1", name: "invoke_tool", arguments: { name: "memory_write", args_json: "{}" } },
        },
        { type: "done", data: {} },
      ]));
      expect(out.usedTools).toEqual(["memory_write"]);
    });

    it("leaves a direct (non-proxied) tool call unaffected regardless of its result shape", async () => {
      const out = await collectStream(fromArray([
        { type: "tool_call", data: { id: "call-1", name: "web_search", arguments: { q: "x" } } },
        { type: "tool_result", data: { id: "call-1", name: "web_search", result: { ok: false } } },
        { type: "done", data: {} },
      ]));
      expect(out.usedTools).toEqual(["web_search"]);
    });

    it("does not let one rejected proxied call suppress a different, genuinely successful one", async () => {
      const out = await collectStream(fromArray([
        {
          type: "tool_call",
          data: { id: "call-1", name: "invoke_tool", arguments: { name: "memory_write", args_json: "bad" } },
        },
        {
          type: "tool_result",
          data: {
            id: "call-1",
            name: "invoke_tool",
            result: { ok: false, tool: "memory_write", status: "rejected", error: "bad_args_json" },
          },
        },
        {
          type: "tool_call",
          data: { id: "call-2", name: "invoke_tool", arguments: { name: "memory_write", args_json: "{}" } },
        },
        {
          type: "tool_result",
          data: {
            id: "call-2",
            name: "invoke_tool",
            result: { ok: true, tool: "memory_write", status: "done", result: {} },
          },
        },
        { type: "done", data: {} },
      ]));
      expect(out.usedTools).toEqual(["memory_write"]);
    });
  });
});
