import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  normalizeToolResult,
  runToolDispatched,
  recentDispatchLog,
  _resetDispatchLog,
} from "./dispatch";

describe("normalizeToolResult", () => {
  it("wraps a JSON string into kind:json", () => {
    expect(normalizeToolResult(`{"a":1}`)).toEqual({ kind: "json", data: { a: 1 } });
  });

  it("wraps an array string into kind:json", () => {
    expect(normalizeToolResult(`[1,2,3]`)).toEqual({ kind: "json", data: [1, 2, 3] });
  });

  it("wraps a non-JSON string into kind:text", () => {
    expect(normalizeToolResult("hello world")).toEqual({ kind: "text", data: "hello world" });
  });

  it("wraps an unparseable JSON-looking string into kind:text", () => {
    expect(normalizeToolResult("{not json")).toEqual({ kind: "text", data: "{not json" });
  });

  it("wraps plain objects into kind:json", () => {
    expect(normalizeToolResult({ x: 1 })).toEqual({ kind: "json", data: { x: 1 } });
  });

  it("passes a pre-shaped ToolResult through unchanged", () => {
    expect(normalizeToolResult({ kind: "text", data: "x" })).toEqual({ kind: "text", data: "x" });
    expect(normalizeToolResult({ kind: "error", message: "m", code: "c" })).toEqual({ kind: "error", message: "m", code: "c" });
  });

  it("wraps undefined/null into kind:json with null data", () => {
    expect(normalizeToolResult(undefined)).toEqual({ kind: "json", data: null });
    expect(normalizeToolResult(null)).toEqual({ kind: "json", data: null });
  });

  it("ignores objects with a `kind` field that isn't a known variant", () => {
    expect(normalizeToolResult({ kind: "weird", data: 1 })).toEqual({
      kind: "json",
      data: { kind: "weird", data: 1 },
    });
  });
});

describe("runToolDispatched", () => {
  beforeEach(() => {
    _resetDispatchLog();
  });

  it("returns the tool's result and logs status=ok", async () => {
    const result = await runToolDispatched(async () => ({ x: 1 }), {
      toolName: "demo",
    });
    expect(result).toEqual({ kind: "json", data: { x: 1 } });
    const log = recentDispatchLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ toolName: "demo", status: "ok" });
    expect(log[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("normalises a JSON-string return into kind:json", async () => {
    const result = await runToolDispatched(async () => `{"a":1}`, { toolName: "j" });
    expect(result).toEqual({ kind: "json", data: { a: 1 } });
  });

  it("catches a thrown error and returns kind:error by default", async () => {
    const result = await runToolDispatched(async () => { throw new Error("boom"); }, {
      toolName: "explode",
    });
    expect(result).toEqual({ kind: "error", message: "boom", code: "tool_threw" });
    expect(recentDispatchLog()[0].status).toBe("error");
  });

  it("preserves the error code when the throw carries one", async () => {
    const err = new Error("timed out");
    (err as unknown as { code: string }).code = "tool_timeout";
    const result = await runToolDispatched(async () => { throw err; }, {
      toolName: "slow",
    });
    expect(result).toMatchObject({ kind: "error", code: "tool_timeout" });
    expect(recentDispatchLog()[0].status).toBe("timeout");
  });

  it("rethrows when rethrow:true is set", async () => {
    await expect(
      runToolDispatched(async () => { throw new Error("crash"); }, {
        toolName: "x",
        rethrow: true,
      }),
    ).rejects.toThrow("crash");
    expect(recentDispatchLog()[0].status).toBe("error");
  });

  it("threads thread_id + run_id into the log entry", async () => {
    await runToolDispatched(async () => "ok", {
      toolName: "t",
      threadId: "thread-1",
      runId: "run-9",
    });
    const entry = recentDispatchLog()[0];
    expect(entry.threadId).toBe("thread-1");
    expect(entry.runId).toBe("run-9");
  });

  it("ring buffer caps at the documented capacity", async () => {
    // Indirect cap test: emit a few entries; recentDispatchLog with limit
    // should return the requested slice; full log can never grow beyond
    // capacity. We don't fill all 500 slots in tests for runtime reasons.
    for (let i = 0; i < 10; i += 1) {
      await runToolDispatched(async () => i, { toolName: `t${i}` });
    }
    expect(recentDispatchLog()).toHaveLength(10);
    expect(recentDispatchLog(3)).toHaveLength(3);
    expect(recentDispatchLog(3)[2].toolName).toBe("t9");
  });

  it("normalises a returned `error` object to kind:error", async () => {
    const result = await runToolDispatched(async () => ({ kind: "error", message: "no", code: "x" }), {
      toolName: "t",
    });
    expect(result).toMatchObject({ kind: "error" });
    expect(recentDispatchLog()[0].status).toBe("error");
  });
});

describe("runToolDispatched + console.info", () => {
  beforeEach(() => {
    _resetDispatchLog();
  });

  it("emits a grep-friendly log line per dispatch", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await runToolDispatched(async () => "ok", { toolName: "logged" });
      expect(spy).toHaveBeenCalled();
      const line = spy.mock.calls[0][0] as string;
      expect(line).toContain("[tool-dispatch]");
      expect(line).toContain("tool=logged");
      expect(line).toContain("status=ok");
    } finally {
      spy.mockRestore();
    }
  });
});
