import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-fetch-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { resetConfigCache } = await import("@/lib/env/config");
const { webFetchTool } = await import("./fetch");

function parse(s: string) { return JSON.parse(s) as Record<string, unknown>; }

const realFetch = globalThis.fetch;
beforeEach(() => { resetConfigCache(); });
afterEach(() => { globalThis.fetch = realFetch; });

describe("web_fetch timeout reporting", () => {
  it("surfaces a timed_out=true result with an actionable hint when the abort fires", async () => {
    // Simulate undici's AbortError directly rather than waiting for the
    // internal AbortController to fire — fetch.ts's catch block
    // recognises the AbortError name and produces the timed_out envelope
    // regardless of which clock fired it.
    globalThis.fetch = vi.fn(async () => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;

    const out = parse(await webFetchTool.invoke({ url: "https://example.com/slow" }));
    expect(out.timed_out).toBe(true);
    expect(typeof out.timeout_ms).toBe("number");
    expect(String(out.error)).toMatch(/timed out after/i);
    expect(String(out.error)).toMatch(/different URL|deadline_ms/i);
  });

  it("does not flag non-timeout failures as timed_out", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:1");
    }) as unknown as typeof fetch;

    const out = parse(await webFetchTool.invoke({ url: "https://example.com/dead" }));
    expect(out.timed_out).toBeUndefined();
    expect(String(out.error)).toMatch(/ECONNREFUSED/);
  });
});
