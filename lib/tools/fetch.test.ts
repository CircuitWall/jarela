import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-fetch-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
process.env.JARELA_FETCH_TOOL_TIMEOUT_MS = "150";
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  delete process.env.JARELA_FETCH_TOOL_TIMEOUT_MS;
});

const { resetConfigCache } = await import("@/lib/env/config");
const { webFetchTool } = await import("./fetch");

function parse(s: string) { return JSON.parse(s) as Record<string, unknown>; }

const realFetch = globalThis.fetch;
beforeEach(() => { resetConfigCache(); });
afterEach(() => { globalThis.fetch = realFetch; });

describe("web_fetch timeout reporting", () => {
  it("surfaces a timed_out=true result with an actionable hint when the abort fires", async () => {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      // Wait for the tool's AbortController to fire, then reject like undici
      // does when the signal aborts mid-request.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const out = parse(await webFetchTool.invoke({ url: "https://example.com/slow" }));
    expect(out.timed_out).toBe(true);
    expect(out.timeout_ms).toBe(150);
    expect(String(out.error)).toMatch(/timed out after/i);
    expect(String(out.error)).toMatch(/JARELA_FETCH_TOOL_TIMEOUT_MS|different URL/i);
  }, 5_000);

  it("does not flag non-timeout failures as timed_out", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:1");
    }) as unknown as typeof fetch;

    const out = parse(await webFetchTool.invoke({ url: "https://example.com/dead" }));
    expect(out.timed_out).toBeUndefined();
    expect(String(out.error)).toMatch(/ECONNREFUSED/);
  });
});
