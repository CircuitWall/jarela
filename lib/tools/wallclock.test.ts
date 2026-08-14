import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { wrapWithWallclock, __DEFAULT_DEADLINE_MS } from "./wallclock";
import { withStreamDefault } from "./tool-metadata";

interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
}

function makeReportingTool(name: string, steps: Array<{ delayMs: number; text?: string }>, finalDelayMs = 0) {
  return tool(
    async ({ value }: { value: string }, config?: unknown) => {
      const writer = (config as { writer?: (c: unknown) => void } | undefined)?.writer;
      for (const step of steps) {
        await new Promise((r) => setTimeout(r, step.delayMs));
        if (step.text) writer?.({ text: step.text });
      }
      if (finalDelayMs) await new Promise((r) => setTimeout(r, finalDelayMs));
      return JSON.stringify({ ok: true, value });
    },
    { name, description: "test", schema: z.object({ value: z.string() }) },
  );
}

// Mimics an external .cjs tool or an MCP tool: `schema` is a plain JSON
// Schema object, not a Zod schema (see wrapExternalTool in ./external.ts).
function makeJsonSchemaTool(name: string, delayMs: number, schema: Record<string, unknown>) {
  return tool(
    async (args: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, delayMs));
      return JSON.stringify({ ok: true, args });
    },
    { name, description: "test", schema: schema as never },
  );
}

function makeSlowTool(name: string, delayMs: number) {
  return tool(
    async ({ value }: { value: string }) => {
      await new Promise((r) => setTimeout(r, delayMs));
      return JSON.stringify({ ok: true, value });
    },
    {
      name,
      description: "test",
      schema: z.object({ value: z.string() }),
    },
  );
}

describe("wrapWithWallclock", () => {
  it("passes through when the tool finishes inside the budget", async () => {
    const inner = makeSlowTool("fast", 5);
    const wrapped = wrapWithWallclock(inner);
    const out = await wrapped.invoke({ value: "hi", deadline_ms: 500 });
    expect(JSON.parse(out as string)).toEqual({ ok: true, value: "hi" });
  });

  it("returns a structured timeout result when the budget is exceeded", async () => {
    const inner = makeSlowTool("slow", 5000);
    const wrapped = wrapWithWallclock(inner);
    const out = await wrapped.invoke({ value: "x", deadline_ms: 20 });
    const parsed = JSON.parse(out as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("tool_timeout");
    expect(parsed.deadline_ms).toBe(20);
    expect(parsed.message).toMatch(/exceeded its wall-clock budget/);
    expect(parsed.message).toMatch(/"slow"/);
  });

  it("uses the default budget when deadline_ms is omitted", async () => {
    const inner = makeSlowTool("default-fast", 5);
    const wrapped = wrapWithWallclock(inner);
    const out = await wrapped.invoke({ value: "y" });
    expect(JSON.parse(out as string)).toEqual({ ok: true, value: "y" });
    expect(__DEFAULT_DEADLINE_MS).toBeGreaterThan(0);
  });

  it("extends the schema so deadline_ms is advertised to the LLM", () => {
    const inner = makeSlowTool("schema-check", 5);
    const wrapped = wrapWithWallclock(inner);
    const schema = (wrapped as unknown as { schema: z.ZodObject<z.ZodRawShape> }).schema;
    expect(schema instanceof z.ZodObject).toBe(true);
    expect(Object.keys(schema.shape)).toContain("deadline_ms");
    expect(Object.keys(schema.shape)).toContain("value");
  });

  it("does not leak the deadline_ms field into the inner tool's args", async () => {
    let seen: unknown = null;
    const inner = tool(
      async (args: Record<string, unknown>) => {
        seen = args;
        return JSON.stringify({ ok: true });
      },
      {
        name: "echo",
        description: "echoes args",
        schema: z.object({ value: z.string() }).passthrough(),
      },
    );
    const wrapped = wrapWithWallclock(inner);
    await wrapped.invoke({ value: "x", deadline_ms: 500 });
    expect(seen).toEqual({ value: "x" });
  });

  it("preserves name and description", () => {
    const inner = makeSlowTool("preserve-name", 5);
    const wrapped = wrapWithWallclock(inner);
    expect(wrapped.name).toBe("preserve-name");
    expect(wrapped.description).toBe("test");
  });

  describe("activity resets the deadline (config.writer)", () => {
    it("does not abandon a call whose total runtime exceeds deadline_ms, as long as it keeps reporting progress", async () => {
      // Total runtime ~90ms, well past the 50ms deadline — but each gap
      // between writer() calls is under 50ms, so it should never fire.
      const inner = makeReportingTool("reporter", [
        { delayMs: 30, text: "step 1" },
        { delayMs: 30, text: "step 2" },
        { delayMs: 30 },
      ]);
      const wrapped = wrapWithWallclock(inner);
      const writer = vi.fn();
      // stream: true — this test is about the activity-reset mechanism,
      // not the per-tool streaming default (covered separately below).
      const out = await wrapped.invoke({ value: "x", deadline_ms: 50, stream: true }, { writer } as never);
      expect(JSON.parse(out as string)).toEqual({ ok: true, value: "x" });
      expect(writer).toHaveBeenCalledTimes(2);
    });

    it("still times out after deadline_ms of silence following earlier activity", async () => {
      const inner = makeReportingTool("stall-after-one-step", [{ delayMs: 5, text: "step 1" }], 500);
      const wrapped = wrapWithWallclock(inner);
      const out = await wrapped.invoke({ value: "x", deadline_ms: 30 }, { writer: () => {} } as never);
      const parsed = JSON.parse(out as string);
      expect(parsed.ok).toBe(false);
      expect(parsed.error_code).toBe("tool_timeout");
    });

    it("forwards the chunk to the caller's original writer after resetting the timer", async () => {
      const inner = makeReportingTool("forwarder", [{ delayMs: 5, text: "hello" }]);
      const wrapped = wrapWithWallclock(inner);
      const writer = vi.fn();
      await wrapped.invoke({ value: "x", deadline_ms: 500, stream: true }, { writer } as never);
      expect(writer).toHaveBeenCalledWith({ text: "hello" });
    });

    it("async_run: keeps a background call alive past the original deadline as long as it reports progress", async () => {
      const inner = makeReportingTool("bg-reporter", [
        { delayMs: 30, text: "step 1" },
        { delayMs: 30, text: "step 2" },
      ]);
      const wrapped = wrapWithWallclock(inner);
      const writer = vi.fn();
      const handoff = await wrapped.invoke({ value: "x", deadline_ms: 50, async_run: true, stream: true }, { writer } as never);
      const { key } = JSON.parse(handoff as string);
      expect(key).toBeTruthy();
      // Give the background work time to finish (well past the 50ms deadline).
      await new Promise((r) => setTimeout(r, 100));
      expect(writer).toHaveBeenCalledTimes(2);
    });
  });

  describe("stream field (per-tool default, agent-overridable)", () => {
    it("extends the schema so stream is advertised to the LLM", () => {
      const inner = makeSlowTool("stream-schema-check", 5);
      const wrapped = wrapWithWallclock(inner);
      const schema = (wrapped as unknown as { schema: z.ZodObject<z.ZodRawShape> }).schema;
      expect(Object.keys(schema.shape)).toContain("stream");
    });

    it("does not leak the stream field into the inner tool's args", async () => {
      let seen: unknown = null;
      const inner = tool(
        async (args: Record<string, unknown>) => {
          seen = args;
          return JSON.stringify({ ok: true });
        },
        { name: "echo-stream", description: "echoes args", schema: z.object({ value: z.string() }).passthrough() },
      );
      const wrapped = wrapWithWallclock(inner);
      await wrapped.invoke({ value: "x", stream: true });
      expect(seen).toEqual({ value: "x" });
    });

    it("defaults to false for a tool that never declares withStreamDefault", async () => {
      const inner = makeReportingTool("quiet-by-default", [{ delayMs: 5, text: "hello" }]);
      const wrapped = wrapWithWallclock(inner);
      const writer = vi.fn();
      await wrapped.invoke({ value: "x", deadline_ms: 500 }, { writer } as never);
      expect(writer).not.toHaveBeenCalled();
    });

    it("forwards progress by default once the tool's own module declares withStreamDefault(tool, true)", async () => {
      // This is the whole point: the default lives at the tool's own
      // definition site (see e.g. claude-delegate.ts), not in a name list
      // wallclock.ts has to know about.
      const inner = withStreamDefault(
        makeReportingTool("self-declared-streaming", [{ delayMs: 5, text: "hello" }]),
        true,
      );
      const wrapped = wrapWithWallclock(inner);
      const writer = vi.fn();
      await wrapped.invoke({ value: "x", deadline_ms: 500 }, { writer } as never);
      expect(writer).toHaveBeenCalledWith({ text: "hello" });
    });

    it("agent can override the default on: stream: true forwards even for a normally-quiet tool", async () => {
      const inner = makeReportingTool("quiet-but-overridden", [{ delayMs: 5, text: "hello" }]);
      const wrapped = wrapWithWallclock(inner);
      const writer = vi.fn();
      await wrapped.invoke({ value: "x", deadline_ms: 500, stream: true }, { writer } as never);
      expect(writer).toHaveBeenCalledWith({ text: "hello" });
    });

    it("agent can override the default off: stream: false silences a tool that declared streaming by default", async () => {
      const inner = withStreamDefault(
        makeReportingTool("self-declared-but-overridden", [{ delayMs: 5, text: "hello" }]),
        true,
      );
      const wrapped = wrapWithWallclock(inner);
      const writer = vi.fn();
      await wrapped.invoke({ value: "x", deadline_ms: 500, stream: false }, { writer } as never);
      expect(writer).not.toHaveBeenCalled();
    });

    it("still resets the idle timer on activity even when streaming is off", async () => {
      // Same shape as the "does not abandon a call that keeps reporting
      // progress" test above, but with streaming off — the budget must
      // still extend on each writer() call even though nothing is
      // forwarded to the caller.
      const inner = makeReportingTool("silent-but-alive", [
        { delayMs: 30, text: "step 1" },
        { delayMs: 30, text: "step 2" },
        { delayMs: 30 },
      ]);
      const wrapped = wrapWithWallclock(inner);
      const writer = vi.fn();
      const out = await wrapped.invoke({ value: "x", deadline_ms: 50, stream: false }, { writer } as never);
      expect(JSON.parse(out as string)).toEqual({ ok: true, value: "x" });
      expect(writer).not.toHaveBeenCalled();
    });

    it("JSON-Schema tools (external/MCP) get deadline_ms/async_run/stream merged into `properties`", () => {
      const inner = makeJsonSchemaTool("json-schema-check", 5, { type: "object", properties: { value: { type: "string" } } });
      const wrapped = wrapWithWallclock(inner);
      const schema = (wrapped as unknown as { schema: JsonSchema }).schema;
      expect(Object.keys(schema.properties ?? {})).toEqual(
        expect.arrayContaining(["value", "deadline_ms", "async_run", "stream"]),
      );
      // Original property survives the merge untouched.
      expect(schema.properties?.value).toEqual({ type: "string" });
    });

    it("treats a `properties`-only schema (no explicit `type: object`) as object-shaped too", () => {
      const inner = makeJsonSchemaTool("no-type-check", 5, { properties: {} });
      const wrapped = wrapWithWallclock(inner);
      const schema = (wrapped as unknown as { schema: JsonSchema }).schema;
      expect(Object.keys(schema.properties ?? {})).toContain("deadline_ms");
    });

    it("leaves a non-object JSON schema (e.g. a bare string schema) unmerged — no deadline_ms property is added", async () => {
      // A non-object schema shape can't have properties merged into it —
      // isJsonObjectSchema correctly rejects it, so extendedSchema stays
      // null and the original (whatever `tool()` made of it) passes
      // through untouched. This tool still gets raced against the
      // *default* budget below; it just can't advertise deadline_ms.
      const inner = makeJsonSchemaTool("string-schema-check", 5, { type: "string" });
      const wrapped = wrapWithWallclock(inner);
      const schema = (wrapped as unknown as { schema: JsonSchema }).schema;
      expect(schema.properties?.deadline_ms).toBeUndefined();
    });

    it("a JSON-Schema tool actually honors deadline_ms once merged in, not just advertises it", async () => {
      const inner = makeJsonSchemaTool("json-schema-timeout", 500, { type: "object", properties: {} });
      const wrapped = wrapWithWallclock(inner);
      const out = await wrapped.invoke({ deadline_ms: 20 } as never);
      const parsed = JSON.parse(out as string);
      expect(parsed.ok).toBe(false);
      expect(parsed.error_code).toBe("tool_timeout");
    });

    it("async_run respects the stream default too", async () => {
      const inner = makeReportingTool("bg-quiet", [{ delayMs: 5, text: "hello" }]);
      const wrapped = wrapWithWallclock(inner);
      const writer = vi.fn();
      const handoff = await wrapped.invoke({ value: "x", deadline_ms: 500, async_run: true }, { writer } as never);
      const { key } = JSON.parse(handoff as string);
      expect(key).toBeTruthy();
      await new Promise((r) => setTimeout(r, 30));
      expect(writer).not.toHaveBeenCalled();
    });
  });
});
