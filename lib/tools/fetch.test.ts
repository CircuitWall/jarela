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
const allowedSites = await import("@/lib/stores/allowed-sites");

function parse(s: string) { return JSON.parse(s) as Record<string, unknown>; }

function htmlOk(): Response {
  return new Response("<html><head><title>ok</title></head><body>ok</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  resetConfigCache();
  // Wipe the allow-list before each test so cookie / SSRF state from
  // earlier specs can't leak. The store opens its own DB handle on first
  // import; the table exists by then.
  for (const s of allowedSites.listAllowedSites()) allowedSites.removeAllowedSite(s.hostname);
});
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

describe("web_fetch cookie passthrough", () => {
  it("does not attach a Cookie header for hosts not on the allow-list", async () => {
    const seen = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => htmlOk());
    globalThis.fetch = seen as unknown as typeof fetch;

    await webFetchTool.invoke({ url: "https://example.com/" });

    expect(seen).toHaveBeenCalled();
    const init = seen.mock.calls[0][1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Cookie"]).toBeUndefined();
  });

  it("attaches stored cookies for an allow-listed host", async () => {
    allowedSites.addAllowedSite({ hostname: "example.com" });
    allowedSites.putCookies("example.com", [
      { name: "sid", value: "abc123", domain: "example.com", path: "/" },
    ]);

    const seen = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => htmlOk());
    globalThis.fetch = seen as unknown as typeof fetch;

    await webFetchTool.invoke({ url: "https://example.com/" });

    const init = seen.mock.calls[0][1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Cookie"]).toBe("sid=abc123");
  });

  it("strips the Cookie header on a redirect to an off-allow-list host", async () => {
    allowedSites.addAllowedSite({ hostname: "example.com" });
    allowedSites.putCookies("example.com", [
      { name: "sid", value: "abc123", domain: "example.com", path: "/" },
    ]);

    const calls: Array<{ url: string; cookie: string | undefined }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const cookie = ((init?.headers ?? {}) as Record<string, string>)["Cookie"];
      calls.push({ url: String(url), cookie });
      if (calls.length === 1) {
        // First hop: redirect off-allow-list. example.org is a real
        // IANA-reserved domain, so the redirect SSRF check resolves
        // successfully and lets us reach the second hop.
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.org/" },
        });
      }
      return htmlOk();
    }) as unknown as typeof fetch;

    await webFetchTool.invoke({ url: "https://example.com/start" });

    expect(calls).toHaveLength(2);
    expect(calls[0].cookie).toBe("sid=abc123");
    expect(calls[1].cookie).toBeUndefined();
  });
});

describe("web_fetch SSRF bypass via allow-list", () => {
  it("refuses a private/loopback URL when the host is not allow-listed", async () => {
    const out = parse(await webFetchTool.invoke({ url: "http://127.0.0.1:9999/secret" }));
    expect(String(out.error)).toMatch(/private\/loopback/i);
    // Helpful pointer to the new escape hatch.
    expect(String(out.error)).toMatch(/Allowed sites|ssrf|JARELA_ALLOW_PRIVATE_FETCH/i);
  });

  it("allows a private/loopback URL when the host is allow-listed with SSRF bypass", async () => {
    allowedSites.addAllowedSite({ hostname: "127.0.0.1", ssrf_bypass: true });

    const seen = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => htmlOk());
    globalThis.fetch = seen as unknown as typeof fetch;

    const out = parse(await webFetchTool.invoke({ url: "http://127.0.0.1:9999/intranet" }));
    expect(out.error).toBeUndefined();
    expect(seen).toHaveBeenCalled();
  });

  it("still refuses private URLs when the host is allow-listed but bypass is off", async () => {
    allowedSites.addAllowedSite({ hostname: "127.0.0.1", ssrf_bypass: false });
    const out = parse(await webFetchTool.invoke({ url: "http://127.0.0.1:9999/secret" }));
    expect(String(out.error)).toMatch(/private\/loopback/i);
  });
});
