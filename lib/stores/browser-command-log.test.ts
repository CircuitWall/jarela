import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-browser-command-log-"));
process.env.JARELA_DB_DIR = tmpRoot;

const store = await import("./browser-command-log");
const db = await import("@/lib/db");

afterAll(() => {
  db.closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("browser command log", () => {
  it("stores sanitized retryable navigation metadata", () => {
    store.createBrowserCommandLog("cmd-nav", { type: "navigate", url: "https://example.com/path" });
    store.markBrowserCommandRunning("cmd-nav");
    store.completeBrowserCommandLog("cmd-nav", { ok: true, data: { tab_id: 7 } });

    const entry = store.getBrowserCommandLog("cmd-nav");
    expect(entry).toMatchObject({
      cmd_id: "cmd-nav",
      type: "navigate",
      status: "succeeded",
      host: "example.com",
      tab_id: 7,
      retryable: true,
    });
    expect(entry?.summary).toBe("Navigate to example.com/path");
    expect(entry?.retry_payload).toEqual({ type: "navigate", url: "https://example.com/path" });
  });

  it("does not persist form values for fill commands", () => {
    store.createBrowserCommandLog("cmd-fill", { type: "fill", selector: "input[name=password]", value: "secret-value" });
    store.completeBrowserCommandLog("cmd-fill", { ok: false, error: "no element" });

    const entry = store.getBrowserCommandLog("cmd-fill");
    expect(entry?.retryable).toBe(false);
    expect(entry?.retry_payload).toBeNull();
    expect(JSON.stringify(entry)).not.toContain("secret-value");
  });

  it("stores risk metadata separately from command values", () => {
    store.createBrowserCommandLog("cmd-extract", { type: "extract", format: "text" });
    store.updateBrowserCommandRisk("cmd-extract", { level: "sensitive", reasons: ["reads the whole page"] });

    const entry = store.getBrowserCommandLog("cmd-extract");
    expect(entry?.risk_level).toBe("sensitive");
    expect(entry?.risk_reasons).toEqual(["reads the whole page"]);
  });

  it("stores the latest sanitized progress phase", () => {
    store.createBrowserCommandLog("cmd-progress", { type: "navigate", url: "https://example.com" });
    store.markBrowserCommandProgress("cmd-progress", "Waiting For Load!");
    const entry = store.getBrowserCommandLog("cmd-progress");
    expect(entry?.status).toBe("running");
    expect(entry?.last_phase).toBe("waiting_for_load");
    expect(entry?.last_progress_at).toBeTruthy();
  });
});
