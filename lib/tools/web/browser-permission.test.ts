import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin the DB dir before importing anything that opens SQLite.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-browser-permission-"));
process.env.JARELA_DB_DIR = tmpRoot;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { browserPermissionTool } = await import("./browser-permission");
const { addAllowedSite } = await import("@/lib/stores/allowed-sites");
const { _markExtensionSeen, _resetExtensionStatus } = await import("@/lib/api/browser-control");

async function check(url: string) {
  return JSON.parse(await browserPermissionTool.invoke({ url }));
}

beforeEach(() => {
  _resetExtensionStatus();
});

describe("browser_permission", () => {
  it("blocks on the extension channel when the extension has not polled", async () => {
    addAllowedSite({ hostname: "chatty.example" });
    const out = await check("https://chatty.example/inbox");

    expect(out.ready).toBe(false);
    expect(out.blockers).toContain("extension_offline");
    expect(out.layers.channel.fix).toContain("toolbar icon");
    expect(out.blockers).not.toContain("jarela_site_not_allowed");
  });

  it("blocks on the Jarela allow-list and tells the agent how to ask once", async () => {
    _markExtensionSeen();
    const out = await check("https://not-allowed.example/inbox");

    expect(out.ready).toBe(false);
    expect(out.blockers).toEqual(["jarela_site_not_allowed"]);
    expect(out.layers.jarela_site.fix).toContain("allow_site");
    expect(out.layers.jarela_site.fix).toContain("Allowed sites");
    expect(out.ask_user).toBe(true);
  });

  it("is ready once both Jarela-verifiable layers pass", async () => {
    _markExtensionSeen();
    addAllowedSite({ hostname: "allowed.example" });

    const exact = await check("allowed.example");
    expect(exact.ready).toBe(true);
    expect(exact.blockers).toEqual([]);
    expect(exact.layers.jarela_site.rule).toBe("exact");

    const sub = await check("deep.sub.allowed.example/path");
    expect(sub.ready).toBe(true);
    expect(sub.hostname).toBe("allowed.example");
  });

  it("says out loud that the browser's own grant is unverifiable", async () => {
    _markExtensionSeen();
    addAllowedSite({ hostname: "allowed.example" });
    const out = await check("allowed.example");

    expect(out.layers.browser_host_grant.ok).toBeNull();
    expect(out.layers.browser_host_grant.fix).toContain("Site access");
    expect(out.layers.browser_host_grant.fix).toContain("edge://extensions");
  });

  it("rejects unusable input", async () => {
    const out = await check("   ");
    expect(out.allowed).toBe(false);
    expect(out.error).toBeTruthy();
  });
});
