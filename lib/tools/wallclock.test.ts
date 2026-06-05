import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { wrapWithWallclock, __DEFAULT_DEADLINE_MS } from "./wallclock";

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
});
