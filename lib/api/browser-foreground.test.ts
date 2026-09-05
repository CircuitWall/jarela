import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-foreground-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { handleBrowserForeground } = await import("./browser-control");
const { getForegroundTabPresence, clearForegroundTabPresence } = await import("./foreground-presence");
const { setAmbientContextEnabled } = await import("@/lib/stores/app-settings");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const body = {
  url: "https://example.com/pricing",
  title: "Pricing",
  host: "example.com",
  tab_id: 3,
  recorded_at: Date.now(),
};

function req(init: { method?: string; origin?: string; body?: unknown }): Request {
  const host = init.origin ?? "localhost:4312";
  return new Request(`http://${host}/api/v1/extension/browser/foreground`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", host },
    body: init.method === "DELETE" ? undefined : JSON.stringify(init.body ?? body),
  });
}

beforeEach(() => {
  clearForegroundTabPresence();
  setAmbientContextEnabled(true);
});

describe("handleBrowserForeground", () => {
  it("records a loopback push", async () => {
    const res = await handleBrowserForeground(req({}));
    expect(res.status).toBe(200);
    expect(getForegroundTabPresence()?.url).toBe(body.url);
  });

  it("refuses non-loopback callers", async () => {
    const res = await handleBrowserForeground(req({ origin: "evil.com" }));
    expect(res.status).toBe(403);
    expect(getForegroundTabPresence()).toBeNull();
  });

  it("rejects a body without a valid url", async () => {
    const res = await handleBrowserForeground(req({ body: { url: "not-a-url" } }));
    expect(res.status).toBe(400);
    expect(getForegroundTabPresence()).toBeNull();
  });

  it("derives the host when the extension omits it", async () => {
    await handleBrowserForeground(req({ body: { url: "https://docs.example.org/a" } }));
    expect(getForegroundTabPresence()?.host).toBe("docs.example.org");
  });

  it("retracts on DELETE", async () => {
    await handleBrowserForeground(req({}));
    const res = await handleBrowserForeground(req({ method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(getForegroundTabPresence()).toBeNull();
  });

  it("drops the record and refuses pushes when ambient context is off", async () => {
    await handleBrowserForeground(req({}));
    setAmbientContextEnabled(false);
    const res = await handleBrowserForeground(req({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: false });
    expect(getForegroundTabPresence()).toBeNull();
  });
});
