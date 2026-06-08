import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { wrapWithWallclock, DEFAULT_MAX_DEADLINE_MS, getMaxDeadlineMs } from "./wallclock";
import {
  __resetStore,
  getAsyncResult,
  listAsyncResults,
  __backdateFinished,
  sweepExpired,
  startAsyncCall,
  completeAsyncCall,
  failAsyncCall,
  consumeAsyncResult,
  MAX_ENTRIES,
} from "./async-results";
import { toolResultGetTool, toolResultListTool } from "./async-results-tool";

function makeSlowTool(name: string, delayMs: number, throws = false) {
  return tool(
    async ({ value }: { value: string }) => {
      await new Promise((r) => setTimeout(r, delayMs));
      if (throws) throw new Error(`boom: ${value}`);
      return JSON.stringify({ ok: true, value });
    },
    { name, description: "test", schema: z.object({ value: z.string() }) },
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

beforeEach(() => { __resetStore(); });

describe("wallclock async_run", () => {
  it("returns immediately with a key when async_run is true", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow", 200));
    const t0 = Date.now();
    const out = await wrapped.invoke({ value: "hi", async_run: true });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(100);
    const parsed = JSON.parse(out as string);
    expect(parsed.async).toBe(true);
    expect(parsed.ok).toBe(true);
    expect(parsed.tool).toBe("slow");
    expect(parsed.key).toMatch(/^async_[0-9a-f]{16}$/);
    expect(parsed.hint).toContain("tool_result_get");
    // Underlying tool is still pending.
    const rec = getAsyncResult(parsed.key);
    expect(rec?.status).toBe("pending");
  });

  it("eventually marks the slot done with the tool's result", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow", 30));
    const out = await wrapped.invoke({ value: "x", async_run: true });
    const { key } = JSON.parse(out as string);
    await waitFor(() => getAsyncResult(key)?.status === "done");
    const rec = getAsyncResult(key)!;
    expect(rec.status).toBe("done");
    expect(JSON.parse(rec.result!)).toEqual({ ok: true, value: "x" });
  });

  it("marks the slot errored when the tool throws", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow-throw", 20, true));
    const out = await wrapped.invoke({ value: "x", async_run: true });
    const { key } = JSON.parse(out as string);
    await waitFor(() => getAsyncResult(key)?.status === "error");
    const rec = getAsyncResult(key)!;
    expect(rec.status).toBe("error");
    expect(rec.error).toContain("boom: x");
  });

  it("marks the slot errored when the deadline fires before completion", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("very-slow", 1000));
    const out = await wrapped.invoke({ value: "x", async_run: true, deadline_ms: 30 });
    const { key } = JSON.parse(out as string);
    await waitFor(() => getAsyncResult(key)?.status === "error");
    const rec = getAsyncResult(key)!;
    expect(rec.error).toMatch(/background wall-clock budget/);
  });

  it("does not leak wrapper fields into the inner tool args", async () => {
    let seen: unknown = null;
    const inner = tool(
      async (args: Record<string, unknown>) => {
        seen = args;
        return JSON.stringify({ ok: true });
      },
      { name: "echo-async", description: "echo", schema: z.object({ value: z.string() }).passthrough() },
    );
    const wrapped = wrapWithWallclock(inner);
    const out = await wrapped.invoke({ value: "x", async_run: true, deadline_ms: 1000 });
    const { key } = JSON.parse(out as string);
    await waitFor(() => getAsyncResult(key)?.status === "done");
    expect(seen).toEqual({ value: "x" });
  });
});

describe("tool_result_get", () => {
  it("returns pending when the call is still running", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow", 500));
    const start = await wrapped.invoke({ value: "x", async_run: true });
    const { key } = JSON.parse(start as string);
    const got = await toolResultGetTool.invoke({ key });
    const parsed = JSON.parse(got as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("pending");
    expect(parsed.key).toBe(key);
  });

  it("returns the result once done", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow", 20));
    const start = await wrapped.invoke({ value: "hello", async_run: true });
    const { key } = JSON.parse(start as string);
    await waitFor(() => getAsyncResult(key)?.status === "done");
    const got = await toolResultGetTool.invoke({ key });
    const parsed = JSON.parse(got as string);
    expect(parsed.status).toBe("done");
    expect(JSON.parse(parsed.result)).toEqual({ ok: true, value: "hello" });
    expect(typeof parsed.elapsed_ms).toBe("number");
  });

  it("short-polls via wait_ms when the call finishes inside the budget", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow", 50));
    const start = await wrapped.invoke({ value: "x", async_run: true });
    const { key } = JSON.parse(start as string);
    const t0 = Date.now();
    const got = await toolResultGetTool.invoke({ key, wait_ms: 500 });
    const elapsed = Date.now() - t0;
    const parsed = JSON.parse(got as string);
    expect(parsed.status).toBe("done");
    expect(elapsed).toBeLessThan(450); // resolved well before the 500ms budget
  });

  it("returns the error envelope when the call failed", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow-throw", 10, true));
    const start = await wrapped.invoke({ value: "x", async_run: true });
    const { key } = JSON.parse(start as string);
    await waitFor(() => getAsyncResult(key)?.status === "error");
    const got = await toolResultGetTool.invoke({ key });
    const parsed = JSON.parse(got as string);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toContain("boom");
  });

  it("returns status=unknown for a missing key", async () => {
    const got = await toolResultGetTool.invoke({ key: "async_does_not_exist" });
    const parsed = JSON.parse(got as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("unknown");
  });

  it("deletes the entry when consume=true on a finished call", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow", 15));
    const start = await wrapped.invoke({ value: "x", async_run: true });
    const { key } = JSON.parse(start as string);
    await waitFor(() => getAsyncResult(key)?.status === "done");
    await toolResultGetTool.invoke({ key, consume: true });
    expect(getAsyncResult(key)).toBeNull();
  });

  it("does NOT delete a pending entry when consume=true", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow", 500));
    const start = await wrapped.invoke({ value: "x", async_run: true });
    const { key } = JSON.parse(start as string);
    await toolResultGetTool.invoke({ key, consume: true });
    expect(getAsyncResult(key)).not.toBeNull();
  });
});

describe("tool_result_list", () => {
  it("returns a summary of every entry", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow", 15));
    await wrapped.invoke({ value: "a", async_run: true });
    await wrapped.invoke({ value: "b", async_run: true });
    const out = await toolResultListTool.invoke({});
    const parsed = JSON.parse(out as string);
    expect(parsed.count).toBe(2);
    // No `result` field leaks in the list summary.
    for (const r of parsed.results) {
      expect(r).not.toHaveProperty("result");
      expect(r).not.toHaveProperty("error");
    }
  });

  it("filters by status", async () => {
    const fast = wrapWithWallclock(makeSlowTool("fast", 10));
    const slow = wrapWithWallclock(makeSlowTool("slow", 1000));
    const a = await fast.invoke({ value: "a", async_run: true });
    await slow.invoke({ value: "b", async_run: true });
    const aKey = JSON.parse(a as string).key;
    await waitFor(() => getAsyncResult(aKey)?.status === "done");
    const done = JSON.parse(await toolResultListTool.invoke({ status: "done" }) as string);
    const pending = JSON.parse(await toolResultListTool.invoke({ status: "pending" }) as string);
    expect(done.count).toBe(1);
    expect(pending.count).toBe(1);
  });
});

describe("sweepExpired", () => {
  it("drops finished entries older than the TTL but keeps pending ones", async () => {
    const fast = wrapWithWallclock(makeSlowTool("fast", 10));
    const slow = wrapWithWallclock(makeSlowTool("slow", 5000));
    const a = JSON.parse(await fast.invoke({ value: "a", async_run: true }) as string).key;
    const b = JSON.parse(await slow.invoke({ value: "b", async_run: true }) as string).key;
    await waitFor(() => getAsyncResult(a)?.status === "done");
    __backdateFinished(a, Date.now() - 60_000);
    const removed = sweepExpired(1_000);
    expect(removed).toBe(1);
    expect(getAsyncResult(a)).toBeNull();
    expect(getAsyncResult(b)).not.toBeNull();
    expect(listAsyncResults()).toHaveLength(1);
  });

  it("does not remove entries that are still within the TTL", async () => {
    const fast = wrapWithWallclock(makeSlowTool("fast", 10));
    const k = JSON.parse(await fast.invoke({ value: "x", async_run: true }) as string).key;
    await waitFor(() => getAsyncResult(k)?.status === "done");
    const removed = sweepExpired(60_000);
    expect(removed).toBe(0);
    expect(getAsyncResult(k)).not.toBeNull();
  });

  it("does not remove pending entries even with a tiny TTL", async () => {
    const slow = wrapWithWallclock(makeSlowTool("slow", 5000));
    const k = JSON.parse(await slow.invoke({ value: "x", async_run: true }) as string).key;
    const removed = sweepExpired(0);
    expect(removed).toBe(0);
    expect(getAsyncResult(k)?.status).toBe("pending");
  });
});

describe("low-level store API", () => {
  it("startAsyncCall returns unique keys per call", () => {
    const keys = new Set(Array.from({ length: 50 }, () => startAsyncCall("t")));
    expect(keys.size).toBe(50);
    for (const k of keys) {
      expect(k).toMatch(/^async_[0-9a-f]{16}$/);
    }
  });

  it("completeAsyncCall is a no-op for an unknown key", () => {
    expect(() => completeAsyncCall("nope", "x")).not.toThrow();
  });

  it("failAsyncCall is a no-op for an unknown key", () => {
    expect(() => failAsyncCall("nope", "x")).not.toThrow();
  });

  it("consumeAsyncResult returns the record and deletes it", () => {
    const k = startAsyncCall("t");
    completeAsyncCall(k, "result-body");
    const rec = consumeAsyncResult(k);
    expect(rec?.result).toBe("result-body");
    expect(getAsyncResult(k)).toBeNull();
    // Second consume returns null.
    expect(consumeAsyncResult(k)).toBeNull();
  });

  it("listAsyncResults returns newest-first", async () => {
    const a = startAsyncCall("t");
    await new Promise((r) => setTimeout(r, 5));
    const b = startAsyncCall("t");
    await new Promise((r) => setTimeout(r, 5));
    const c = startAsyncCall("t");
    const list = listAsyncResults();
    expect(list.map((r) => r.key)).toEqual([c, b, a]);
  });
});

describe("store capacity cap (MAX_ENTRIES)", () => {
  it("evicts a finished entry first when the cap is hit", () => {
    // Fill the store: first entry is finished, rest are pending.
    const finishedKey = startAsyncCall("t");
    completeAsyncCall(finishedKey, "old");
    const pendingKeys: string[] = [];
    for (let i = 0; i < MAX_ENTRIES - 1; i++) {
      pendingKeys.push(startAsyncCall("t"));
    }
    expect(listAsyncResults()).toHaveLength(MAX_ENTRIES);
    // Adding one more should evict the finished entry (oldest finished).
    const overflow = startAsyncCall("t");
    expect(getAsyncResult(finishedKey)).toBeNull();
    for (const k of pendingKeys) {
      expect(getAsyncResult(k)).not.toBeNull();
    }
    expect(getAsyncResult(overflow)).not.toBeNull();
    expect(listAsyncResults()).toHaveLength(MAX_ENTRIES);
  });

  it("falls back to evicting the oldest pending when every entry is pending", () => {
    const keys: string[] = [];
    for (let i = 0; i < MAX_ENTRIES; i++) {
      keys.push(startAsyncCall("t"));
    }
    const oldest = keys[0];
    const overflow = startAsyncCall("t");
    expect(getAsyncResult(oldest)).toBeNull();
    expect(getAsyncResult(overflow)).not.toBeNull();
    expect(listAsyncResults()).toHaveLength(MAX_ENTRIES);
  });
});

describe("non-string tool results", () => {
  it("JSON.stringify-ifies object results when storing", async () => {
    const objectTool = tool(
      async () => ({ a: 1, b: [2, 3] }) as unknown as string,
      { name: "obj", description: "x", schema: z.object({}).passthrough() },
    );
    const wrapped = wrapWithWallclock(objectTool);
    const start = await wrapped.invoke({ async_run: true });
    const { key } = JSON.parse(start as string);
    await waitFor(() => getAsyncResult(key)?.status === "done");
    const rec = getAsyncResult(key)!;
    expect(typeof rec.result).toBe("string");
    expect(JSON.parse(rec.result!)).toEqual({ a: 1, b: [2, 3] });
  });
});

describe("concurrent async invocations don't collide", () => {
  it("20 concurrent async fires all settle with distinct keys", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow", 30));
    const starts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        wrapped.invoke({ value: `v${i}`, async_run: true }),
      ),
    );
    const keys = starts.map((s) => JSON.parse(s as string).key);
    expect(new Set(keys).size).toBe(20);
    await waitFor(
      () => keys.every((k) => getAsyncResult(k)?.status === "done"),
      3_000,
    );
    for (const k of keys) {
      const rec = getAsyncResult(k)!;
      expect(rec.status).toBe("done");
      expect(rec.result).toBeTruthy();
    }
  });
});

describe("tool_result_get edge cases", () => {
  it("ignores a wait_ms of 0 (treated as a non-blocking peek)", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow", 500));
    const start = await wrapped.invoke({ value: "x", async_run: true });
    const { key } = JSON.parse(start as string);
    const t0 = Date.now();
    const out = await toolResultGetTool.invoke({ key, wait_ms: 0 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(50);
    const parsed = JSON.parse(out as string);
    expect(parsed.status).toBe("pending");
  });

  it("returns status=pending without short-poll if wait_ms is omitted", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow", 500));
    const start = await wrapped.invoke({ value: "x", async_run: true });
    const { key } = JSON.parse(start as string);
    const out = await toolResultGetTool.invoke({ key });
    expect(JSON.parse(out as string).status).toBe("pending");
  });

  it("rejects out-of-range wait_ms via schema validation", async () => {
    // Schema caps at 60_000.
    let threw = false;
    try {
      await toolResultGetTool.invoke({ key: "x", wait_ms: 999_999 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("elapsed_ms is computed from started_at to now while pending", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow", 500));
    const start = await wrapped.invoke({ value: "x", async_run: true });
    const { key } = JSON.parse(start as string);
    await new Promise((r) => setTimeout(r, 30));
    const out = await toolResultGetTool.invoke({ key });
    const parsed = JSON.parse(out as string);
    expect(parsed.elapsed_ms).toBeGreaterThanOrEqual(20);
  });
});

describe("schema extension surface", () => {
  it("wrapped tools advertise both deadline_ms and async_run on a zod-object schema", () => {
    const inner = makeSlowTool("with-schema", 5);
    const wrapped = wrapWithWallclock(inner);
    const schema = (wrapped as unknown as { schema: z.ZodObject<z.ZodRawShape> }).schema;
    expect(schema instanceof z.ZodObject).toBe(true);
    const keys = Object.keys(schema.shape);
    expect(keys).toContain("value");
    expect(keys).toContain("deadline_ms");
    expect(keys).toContain("async_run");
  });

  it("tool_result_get and tool_result_list themselves accept async_run (they're wrapped too at registry time)", () => {
    // The tools imported here are the *unwrapped* ones; the registry
    // wraps them with wallclock. We just sanity-check that their inner
    // schema is a zod-object so the wrap would succeed.
    const getSchema = (toolResultGetTool as unknown as { schema: z.ZodObject<z.ZodRawShape> }).schema;
    const listSchema = (toolResultListTool as unknown as { schema: z.ZodObject<z.ZodRawShape> }).schema;
    expect(getSchema instanceof z.ZodObject).toBe(true);
    expect(listSchema instanceof z.ZodObject).toBe(true);
  });
});

describe("deadline_ms ceiling", () => {
  beforeEach(() => { delete process.env.JARELA_TOOL_MAX_DEADLINE_MS; });

  it("defaults to 30 minutes", () => {
    expect(DEFAULT_MAX_DEADLINE_MS).toBe(30 * 60 * 1000);
    expect(getMaxDeadlineMs()).toBe(DEFAULT_MAX_DEADLINE_MS);
  });

  it("honours JARELA_TOOL_MAX_DEADLINE_MS override", () => {
    process.env.JARELA_TOOL_MAX_DEADLINE_MS = "5000";
    expect(getMaxDeadlineMs()).toBe(5000);
  });

  it("falls back to default when override is non-numeric or non-positive", () => {
    process.env.JARELA_TOOL_MAX_DEADLINE_MS = "not-a-number";
    expect(getMaxDeadlineMs()).toBe(DEFAULT_MAX_DEADLINE_MS);
    process.env.JARELA_TOOL_MAX_DEADLINE_MS = "0";
    expect(getMaxDeadlineMs()).toBe(DEFAULT_MAX_DEADLINE_MS);
    process.env.JARELA_TOOL_MAX_DEADLINE_MS = "-10";
    expect(getMaxDeadlineMs()).toBe(DEFAULT_MAX_DEADLINE_MS);
  });

  it("clamps a requested deadline above the ceiling and times out at the ceiling", async () => {
    process.env.JARELA_TOOL_MAX_DEADLINE_MS = "50";
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: unknown) => { warns.push(String(msg)); };
    try {
      const wrapped = wrapWithWallclock(makeSlowTool("slow", 500));
      const t0 = Date.now();
      const out = await wrapped.invoke({ value: "x", deadline_ms: 60_000 });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(400);
      const parsed = JSON.parse(out as string);
      expect(parsed.ok).toBe(false);
      expect(parsed.error_code).toBe("tool_timeout");
      expect(parsed.deadline_ms).toBe(50);
      expect(warns.some((w) => w.includes("exceeds ceiling"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it("does not warn when the requested deadline is within the ceiling", async () => {
    process.env.JARELA_TOOL_MAX_DEADLINE_MS = "10000";
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: unknown) => { warns.push(String(msg)); };
    try {
      const wrapped = wrapWithWallclock(makeSlowTool("fast", 5));
      await wrapped.invoke({ value: "x", deadline_ms: 500 });
      expect(warns.filter((w) => w.includes("exceeds ceiling"))).toHaveLength(0);
    } finally {
      console.warn = origWarn;
    }
  });

  it("applies the ceiling to async_run invocations too", async () => {
    process.env.JARELA_TOOL_MAX_DEADLINE_MS = "30";
    const wrapped = wrapWithWallclock(makeSlowTool("slow-async", 300));
    const start = await wrapped.invoke({ value: "x", deadline_ms: 60_000, async_run: true });
    const { key, deadline_ms } = JSON.parse(start as string);
    expect(deadline_ms).toBe(30);
    await waitFor(() => getAsyncResult(key)?.status === "error");
    const rec = getAsyncResult(key)!;
    expect(rec.error).toContain("budget of 30ms");
  });
});
