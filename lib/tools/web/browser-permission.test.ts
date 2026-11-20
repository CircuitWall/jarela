import { describe, it, expect, afterAll } from "vitest";
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

async function check(url: string) {
  return JSON.parse(await browserPermissionTool.invoke({ url }));
}

describe("browser_permission", () => {
  it("reports the ask-user path for a host that is not allowed", async () => {
    const out = await check("https://not-allowed.example/inbox");

    expect(out.allowed).toBe(false);
    expect(out.hostname).toBe("not-allowed.example");
    expect(out.ask_user).toBe(true);
    expect(out.propose_kind).toBe("allow_site");
    // The instruction has to name both halves: the proposal and where the
    // decision is reviewable, otherwise the model either skips asking or
    // sends the user somewhere that does not exist.
    expect(out.instruction).toContain("allow_site");
    expect(out.instruction).toContain("Allowed sites");
  });

  it("reports an allowed host, including subdomains of an allowed entry", async () => {
    addAllowedSite({ hostname: "allowed.example" });

    const exact = await check("allowed.example");
    expect(exact.allowed).toBe(true);
    expect(exact.rule).toBe("exact");

    const sub = await check("deep.sub.allowed.example/path");
    expect(sub.allowed).toBe(true);
    expect(sub.hostname).toBe("allowed.example");
  });

  it("accepts a bare hostname and rejects unusable input", async () => {
    const bare = await check("allowed.example");
    expect(bare.allowed).toBe(true);

    const empty = await check("   ");
    expect(empty.allowed).toBe(false);
    expect(empty.error).toBeTruthy();
  });
});
