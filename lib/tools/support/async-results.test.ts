import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  appendAsyncProgress,
  readAsyncProgress,
  MAX_ENTRIES,
} from "./async-results";
import { toolResultGetTool, toolResultListTool } from "./async-results-tool";
import { createThread } from "@/lib/stores/threads";
import { getSystemOperation } from "@/lib/stores/system-signals";
import { getDataDir } from "@/lib/db/data-dir";
import { resetConfigCache } from "@/lib/env/config";

// Promotion/async settlement wakes the owning agent through the durable signal
// dispatcher. That is covered by the lifecycle tests; here it would try to run
// a real agent turn, so keep the store real and stub only the dispatch.
vi.mock("@/lib/lifecycle/system-signals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/system-signals")>();
  return { ...actual, requestSystemSignalDispatch: vi.fn() };
});

const TMP_ROOT = mkdtempSync(join(tmpdir(), "jarela-tool-results-"));
process.env.JARELA_DB_DIR = TMP_ROOT;

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

beforeEach(() => { __resetStore(); resetConfigCache(); });
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

describe("wallclock async_run", () => {
  it("returns immediately with a key when async_run is true", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("slow", 200));
    const t0 = Date.now();
    const out = await wrapped.invoke({ value: "hi", async_run: true });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
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

  it("reads a bare async key or a padded reference copied into result_ref.name", async () => {
    const key = startAsyncCall("synthetic_copy");
    completeAsyncCall(key, "copied key result");
    expect(JSON.parse(await toolResultGetTool.invoke({ result_ref: { name: key } }) as string))
      .toMatchObject({ status: "done", result: "copied key result" });
    expect(JSON.parse(await toolResultGetTool.invoke({ result_ref: { name: `  ${key}  ` } }) as string))
      .toMatchObject({ status: "done", result: "copied key result" });
    expect(JSON.parse(await toolResultGetTool.invoke({ key: ` ${key} ` }) as string))
      .toMatchObject({ status: "done", result: "copied key result" });
  });

  it("reads a spilled result_ref in bounded ranges", async () => {
    const payload = "abcdefghij".repeat(20);
    process.env.JARELA_TOOL_RESULT_MAX_BYTES = "32";
    resetConfigCache();
    try {
      const inner = tool(
        async () => payload,
        { name: "large-text", description: "test", schema: z.object({}).passthrough() },
      );
      const wrapped = wrapWithWallclock(inner);
      const out = JSON.parse(await wrapped.invoke({}) as string);
      expect(out.truncated).toBe(true);
      const got = JSON.parse(await toolResultGetTool.invoke({ result_ref: { name: out.result_ref.name }, offset: 5, limit: 12 }) as string);
      expect(got).toMatchObject({ ok: true, status: "done", offset: 5, limit: 12, done: false });
      expect(got.result).toBe(payload.slice(5, 17));
      expect(got.next_offset).toBe(17);
    } finally {
      delete process.env.JARELA_TOOL_RESULT_MAX_BYTES;
      resetConfigCache();
    }
  });

  it("also accepts the deprecated flat {name, offset, limit} shape as a shorthand for result_ref", async () => {
    // Some agents still call with a flat `name` instead of nesting it under
    // `result_ref` â€” accept it rather than failing outright, with a
    // deprecation warning, per the tool_result_get schema-drift fix.
    const payload = "abcdefghij".repeat(20);
    process.env.JARELA_TOOL_RESULT_MAX_BYTES = "32";
    resetConfigCache();
    const warnSpy: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnSpy.push(args); };
    try {
      const inner = tool(
        async () => payload,
        { name: "large-text-flat", description: "test", schema: z.object({}).passthrough() },
      );
      const wrapped = wrapWithWallclock(inner);
      const out = JSON.parse(await wrapped.invoke({}) as string);
      expect(out.truncated).toBe(true);

      const got = JSON.parse(await toolResultGetTool.invoke({ name: out.result_ref.name, offset: 5, limit: 12 }) as string);
      expect(got).toMatchObject({ ok: true, status: "done", offset: 5, limit: 12, done: false });
      expect(got.result).toBe(payload.slice(5, 17));
      expect(warnSpy.some((args) => String(args[0]).includes("deprecated flat \"name\""))).toBe(true);
    } finally {
      console.warn = originalWarn;
      delete process.env.JARELA_TOOL_RESULT_MAX_BYTES;
      resetConfigCache();
    }
  });
});

describe("tool result offload", () => {
  it("returns a disclosed preview plus result_ref for oversized sync results", async () => {
    process.env.JARELA_TOOL_RESULT_MAX_BYTES = "64";
    resetConfigCache();
    try {
      const rows = Array.from({ length: 25 }, (_, i) => ({ id: i, value: `row-${i}` }));
      const inner = tool(
        async () => JSON.stringify(rows),
        { name: "large-json", description: "test", schema: z.object({}).passthrough() },
      );
      const wrapped = wrapWithWallclock(inner);
      const out = JSON.parse(await wrapped.invoke({}) as string);
      expect(out.ok).toBe(true);
      expect(out.truncated).toBe(true);
      expect(out.tool).toBe("large-json");
      expect(out.total_count).toBe(25);
      expect(out.preview).toHaveLength(20);
      expect(out.bytes).toBe(Buffer.byteLength(JSON.stringify(rows)));
      expect(out.result_ref.name).toMatch(/^[a-f0-9]{64}\.json$/);
      const { FILES_DIR } = await import("@/lib/files");
      expect(existsSync(join(FILES_DIR, out.result_ref.name))).toBe(true);
      expect(JSON.parse(readFileSync(join(FILES_DIR, out.result_ref.name), "utf8"))).toEqual(rows);
    } finally {
      delete process.env.JARELA_TOOL_RESULT_MAX_BYTES;
      resetConfigCache();
    }
  });

  it("stores the offload envelope instead of the raw oversized payload for async_run", async () => {
    process.env.JARELA_TOOL_RESULT_MAX_BYTES = "64";
    resetConfigCache();
    try {
      const payload = "x".repeat(500);
      const inner = tool(
        async () => payload,
        { name: "large-async", description: "test", schema: z.object({}).passthrough() },
      );
      const wrapped = wrapWithWallclock(inner);
      const start = JSON.parse(await wrapped.invoke({ async_run: true }) as string);
      await waitFor(() => getAsyncResult(start.key)?.status === "done");
      const rec = getAsyncResult(start.key)!;
      expect(rec.result).not.toBe(payload);
      const got = JSON.parse(await toolResultGetTool.invoke({ key: start.key }) as string);
      expect(got).toMatchObject({ ok: true, status: "done", truncated: true, tool: "large-async" });
      expect(got.result_ref.name).toMatch(/^[a-f0-9]{64}\.txt$/);
    } finally {
      delete process.env.JARELA_TOOL_RESULT_MAX_BYTES;
      resetConfigCache();
    }
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

/** A tool that streams its own output the way local_exec/terminal_exec do. */
function makeOutputTool(
  name: string,
  chunks: Array<{ delayMs: number; text: string }>,
  exitCode = 0,
  holdMs = 0,
) {
  return tool(
    async ({ value }: { value: string }, config?: unknown) => {
      const writer = (config as { writer?: (c: unknown) => void } | undefined)?.writer;
      for (const chunk of chunks) {
        await new Promise((r) => setTimeout(r, chunk.delayMs));
        writer?.({ id: "call-1", name, text: chunk.text, kind: "output" });
      }
      if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
      return JSON.stringify({ ok: true, value, exit_code: exitCode });
    },
    { name, description: "test", schema: z.object({ value: z.string() }) },
  );
}

describe("live output of a running call", () => {
  // The ceiling tests above leave JARELA_TOOL_MAX_DEADLINE_MS set at 30ms.
  beforeEach(() => { delete process.env.JARELA_TOOL_MAX_DEADLINE_MS; });

  it("captures output reported while an async call runs, with the exit code", async () => {
    const wrapped = wrapWithWallclock(makeOutputTool("chatty", [
      { delayMs: 5, text: "compiling\n" },
      { delayMs: 5, text: "linking\n" },
    ], 0));
    const out = await wrapped.invoke({ value: "x", async_run: true, deadline_ms: 1_000 });
    const { key } = JSON.parse(out as string);
    await waitFor(() => getAsyncResult(key)?.status === "done");
    const rec = getAsyncResult(key)!;
    expect(rec.progress).toContain("compiling");
    expect(rec.progress).toContain("linking");
    expect(rec.progress_bytes).toBeGreaterThan(0);
    expect(rec.exit_code).toBe(0);
  });

  it("pages the window from a byte cursor", () => {
    const key = startAsyncCall("manual-output");
    appendAsyncProgress(key, "hello ");
    appendAsyncProgress(key, "world");
    const first = readAsyncProgress(key, 0, 6)!;
    expect(first.text).toBe("hello ");
    expect(first.next_offset).toBe(6);
    expect(first.eof).toBe(false);
    const second = readAsyncProgress(key, first.next_offset, 64)!;
    expect(second.text).toBe("world");
    expect(second.eof).toBe(true);
  });

  it("reports how much scrolled out of the window instead of losing the reader's place", () => {
    const key = startAsyncCall("window-overflow");
    const big = "x".repeat(70 * 1024);
    appendAsyncProgress(key, big);
    const page = readAsyncProgress(key, 0, 64)!;
    expect(page.dropped_bytes).toBeGreaterThan(0);
    expect(page.offset).toBeGreaterThan(0);
    expect(page.text.length).toBe(64);
  });

  it("does not add progress to an unreadable record once it is gone", () => {
    const key = startAsyncCall("consumed");
    appendAsyncProgress(key, "out");
    consumeAsyncResult(key);
    expect(readAsyncProgress(key, 0, 64)).toBeNull();
  });
});

describe("progress log on disk", () => {
  beforeEach(() => { delete process.env.JARELA_TOOL_MAX_DEADLINE_MS; });

  it("writes the stream to a capped log and removes it when the result is consumed", async () => {
    const key = startAsyncCall("log-lifecycle");
    appendAsyncProgress(key, "line one\n");
    const rec = getAsyncResult(key)!;
    expect(rec.log_path).toBeTruthy();
    await waitFor(() => existsSync(rec.log_path!) && readFileSync(rec.log_path!, "utf8").includes("line one"));

    consumeAsyncResult(key);
    await waitFor(() => !existsSync(rec.log_path!));
  });

  it("prunes idle logs older than the retention window when a new one is created", async () => {
    // The global test setup may redirect JARELA_DB_DIR, so resolve the log
    // directory the same way the store does instead of assuming TMP_ROOT.
    const dir = join(getDataDir(), "background-tasks");
    const seed = startAsyncCall("seed");
    appendAsyncProgress(seed, "seed\n");
    expect(existsSync(dir)).toBe(true);

    const stale = join(dir, "async_stale0000000000.log");
    writeFileSync(stale, "stale\n");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    appendAsyncProgress(startAsyncCall("fresh"), "fresh\n");
    await waitFor(() => !existsSync(stale));
  });
});

describe("following a call through tool_result_get", () => {
  beforeEach(() => { delete process.env.JARELA_TOOL_MAX_DEADLINE_MS; });

  it("tool_result_get returns the progress of a pending call", async () => {
    const wrapped = wrapWithWallclock(makeOutputTool("slow-output", [
      { delayMs: 5, text: "started\n" },
    ], 0, 300));
    const out = await wrapped.invoke({ value: "x", async_run: true, deadline_ms: 5_000 });
    const { key } = JSON.parse(out as string);
    await waitFor(() => (getAsyncResult(key)?.progress_bytes ?? 0) > 0);
    const response = JSON.parse(await toolResultGetTool.invoke({ key }) as string);
    expect(response.status).toBe("pending");
    expect(response.progress.text).toContain("started");
    expect(response.progress.next_offset).toBeGreaterThan(0);
    expect(response.hint).toContain("Still running");
  });

  it("captures output for a follower even when the transcript stream is off", async () => {
    const wrapped = wrapWithWallclock(makeOutputTool("quiet-stream", [{ delayMs: 5, text: "quiet line\n" }]));
    const out = await wrapped.invoke({ value: "x", async_run: true, stream: false, deadline_ms: 1_000 });
    const { key } = JSON.parse(out as string);
    await waitFor(() => getAsyncResult(key)?.status === "done");
    expect(getAsyncResult(key)!.progress).toContain("quiet line");
  });

  it("tool_result_list reports progress bytes, last output time and exit code", async () => {
    const wrapped = wrapWithWallclock(makeOutputTool("listed", [{ delayMs: 5, text: "row\n" }], 3));
    const out = await wrapped.invoke({ value: "x", async_run: true, deadline_ms: 1_000 });
    const { key } = JSON.parse(out as string);
    await waitFor(() => getAsyncResult(key)?.status === "done");
    const list = JSON.parse(await toolResultListTool.invoke({}) as string);
    const row = (list.results as Array<Record<string, unknown>>).find((entry) => entry.key === key)!;
    expect(row).toMatchObject({ status: "done", exit_code: 3 });
    expect(row.progress_bytes).toBeGreaterThan(0);
    expect(row.last_output_at).toEqual(expect.any(Number));
  });

  it("returns progress for a finished call only when a cursor is supplied", async () => {
    const wrapped = wrapWithWallclock(makeOutputTool("finished-progress", [{ delayMs: 5, text: "kept\n" }]));
    const out = await wrapped.invoke({ value: "x", async_run: true, deadline_ms: 1_000 });
    const { key } = JSON.parse(out as string);
    await waitFor(() => getAsyncResult(key)?.status === "done");

    const bare = JSON.parse(await toolResultGetTool.invoke({ key }) as string);
    expect(bare.progress).toBeUndefined();

    const paged = JSON.parse(await toolResultGetTool.invoke({ key, cursor: 0 }) as string);
    expect(paged.progress.text).toContain("kept");
    expect(paged.progress.eof).toBe(true);
  });

  it("consume removes the finished call's progress and its log with it", async () => {
    const wrapped = wrapWithWallclock(makeOutputTool("consumed-with-log", [{ delayMs: 5, text: "bye\n" }]));
    const out = await wrapped.invoke({ value: "x", async_run: true, deadline_ms: 1_000 });
    const { key } = JSON.parse(out as string);
    await waitFor(() => getAsyncResult(key)?.status === "done");
    const logPath = getAsyncResult(key)!.log_path!;
    await waitFor(() => existsSync(logPath));

    await toolResultGetTool.invoke({ key, consume: true });
    expect(getAsyncResult(key)).toBeNull();
    await waitFor(() => !existsSync(logPath));
  });

  it("does not expose one thread's progress to another thread", async () => {
    const owner = createThread("progress-owner");
    const stranger = createThread("progress-stranger");
    const wrapped = wrapWithWallclock(makeOutputTool("thread-scoped", [{ delayMs: 5, text: "secret\n" }], 0, 200));
    const out = await wrapped.invoke({ value: "x", async_run: true, deadline_ms: 5_000 }, {
      configurable: { thread_id: owner.thread_id },
    });
    const { key } = JSON.parse(out as string);
    await waitFor(() => (getAsyncResult(key, owner.thread_id)?.progress_bytes ?? 0) > 0);

    const denied = JSON.parse(await toolResultGetTool.invoke({ key, cursor: 0 }, {
      configurable: { thread_id: stranger.thread_id },
    }) as string);
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe("unknown");
  });

  it("wait_ms with a cursor returns as soon as new output arrives", async () => {
    const wrapped = wrapWithWallclock(makeOutputTool("late-output", [
      { delayMs: 120, text: "late line\n" },
    ]));
    const out = await wrapped.invoke({ value: "x", async_run: true, deadline_ms: 5_000 });
    const { key } = JSON.parse(out as string);
    const startedAt = Date.now();
    const response = JSON.parse(await toolResultGetTool.invoke({ key, cursor: 0, wait_ms: 5_000 }) as string);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(response.progress.text).toContain("late line");
  });

  it("wait_ms without a cursor still waits for completion", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("settle-only", 120));
    const out = await wrapped.invoke({ value: "x", async_run: true, deadline_ms: 5_000 });
    const { key } = JSON.parse(out as string);
    const response = JSON.parse(await toolResultGetTool.invoke({ key, wait_ms: 5_000 }) as string);
    expect(response.status).toBe("done");
  });
});

describe("deadline promotion", () => {
  beforeEach(() => { delete process.env.JARELA_TOOL_MAX_DEADLINE_MS; });

  it("moves a thread-owned call to the background instead of abandoning it", async () => {
    const thread = createThread("promotion-agent");
    const wrapped = wrapWithWallclock(makeSlowTool("overrun", 120));
    const out = await wrapped.invoke(
      { value: "x", deadline_ms: 20 },
      { configurable: { thread_id: thread.thread_id } },
    );
    const parsed = JSON.parse(out as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.backgrounded).toBe(true);
    expect(parsed.key).toMatch(/^async_[0-9a-f]{16}$/);
    expect(parsed.message).toMatch(/moved to the background/);
    expect(parsed.message).toMatch(/Do not repeat it/);

    // The abandoned promise is still owned: its real result is recorded.
    await waitFor(() => getAsyncResult(parsed.key, thread.thread_id)?.status === "done");
    const rec = getAsyncResult(parsed.key, thread.thread_id)!;
    expect(JSON.parse(rec.result!)).toEqual({ ok: true, value: "x" });
  });

  it("records that the promoted operation was already in flight", async () => {
    const thread = createThread("promotion-intent-agent");
    const wrapped = wrapWithWallclock(makeSlowTool("overrun-intent", 120));
    const before = Date.now();
    const out = await wrapped.invoke(
      { value: "x", deadline_ms: 20 },
      { configurable: { thread_id: thread.thread_id } },
    );
    const parsed = JSON.parse(out as string);
    const operation = getSystemOperation(parsed.key)!;
    const payload = JSON.parse(operation.payload) as { promoted?: boolean; started_at?: number; deadline_ms?: number };
    // Intent is recorded at promotion time, so it must say the work predates it.
    expect(payload.promoted).toBe(true);
    expect(payload.deadline_ms).toBe(20);
    expect(payload.started_at).toBeGreaterThanOrEqual(before);
    expect(payload.started_at!).toBeLessThanOrEqual(Date.now());
  });

  it("gives concurrent promotions distinct records that both settle", async () => {
    const thread = createThread("promotion-concurrent-agent");
    const wrapped = wrapWithWallclock(makeSlowTool("overrun-concurrent", 120));
    const [a, b] = await Promise.all([
      wrapped.invoke({ value: "a", deadline_ms: 20 }, { configurable: { thread_id: thread.thread_id } }),
      wrapped.invoke({ value: "b", deadline_ms: 20 }, { configurable: { thread_id: thread.thread_id } }),
    ]);
    const receiptA = JSON.parse(a as string);
    const receiptB = JSON.parse(b as string);
    expect(receiptA.backgrounded).toBe(true);
    expect(receiptB.backgrounded).toBe(true);
    expect(receiptA.key).not.toBe(receiptB.key);

    await waitFor(() =>
      getAsyncResult(receiptA.key, thread.thread_id)?.status === "done"
      && getAsyncResult(receiptB.key, thread.thread_id)?.status === "done");
    expect(JSON.parse(getAsyncResult(receiptA.key, thread.thread_id)!.result!)).toEqual({ ok: true, value: "a" });
    expect(JSON.parse(getAsyncResult(receiptB.key, thread.thread_id)!.result!)).toEqual({ ok: true, value: "b" });
  });

  it("does not mark a promoted completion-turn call as wake eligible", async () => {
    const thread = createThread("promotion-completion-agent");
    const wrapped = wrapWithWallclock(makeSlowTool("overrun-completion", 120));
    const out = await wrapped.invoke(
      { value: "x", deadline_ms: 20 },
      { configurable: { thread_id: thread.thread_id, signal_continuation: true } },
    );
    const parsed = JSON.parse(out as string);
    const operation = getSystemOperation(parsed.key)!;
    expect(JSON.parse(operation.payload).wake_eligible).toBe(false);
  });

  it("keeps promoting output seen before the deadline", async () => {    const thread = createThread("promotion-output-agent");
    const wrapped = wrapWithWallclock(makeOutputTool("overrun-chatty", [
      { delayMs: 5, text: "early line\n" },
      { delayMs: 200, text: "never reached in time\n" },
    ]));
    const out = await wrapped.invoke(
      { value: "x", deadline_ms: 40 },
      { configurable: { thread_id: thread.thread_id } },
    );
    const parsed = JSON.parse(out as string);
    expect(parsed.backgrounded).toBe(true);
    const rec = getAsyncResult(parsed.key, thread.thread_id)!;
    expect(rec.progress).toContain("early line");
  });

  it("returns the plain timeout result when there is no owning thread", async () => {
    const wrapped = wrapWithWallclock(makeSlowTool("no-thread", 120));
    const out = await wrapped.invoke({ value: "x", deadline_ms: 20 });
    const parsed = JSON.parse(out as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("tool_timeout");
    expect(parsed.backgrounded).toBeUndefined();
  });
});
