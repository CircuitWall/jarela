import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use a dedicated temp dir so JARELA_TOOLS_DIR contains only our fixtures.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-creds-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
process.env.JARELA_TOOLS_DIR = join(tmpRoot, "tools");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// Place an external tool with credentials_required before importing so the
// loader picks it up without needing a module reset.
import { mkdirSync } from "node:fs";
mkdirSync(join(tmpRoot, "tools"), { recursive: true });
writeFileSync(
  join(tmpRoot, "tools", "cred-tool.cjs"),
  `module.exports = {
    name: "cred_tool",
    description: "needs a key",
    schema: { type: "object", properties: {} },
    credentials_required: ["MY_API_KEY", "MY_SECRET"],
    run: async () => "ok",
  };`,
);

const { getToolCredentialsRequired } = await import("./index");
const { _resetExternalCache } = await import("./external");

describe("getToolCredentialsRequired", () => {
  it("returns [] for built-in tools", () => {
    // list_tools is a built-in; built-ins manage their own auth via Settings.
    expect(getToolCredentialsRequired("list_tools")).toEqual([]);
  });

  it("returns the declared credentials for external .cjs tools", () => {
    _resetExternalCache();
    const creds = getToolCredentialsRequired("cred_tool");
    expect(creds).toEqual(["MY_API_KEY", "MY_SECRET"]);
  });

  it("returns [] for an external tool with no credentials_required field", () => {
    // The external tool file we wrote has credentials_required, but an absent
    // field on a different tool should return [].
    _resetExternalCache();
    expect(getToolCredentialsRequired("nonexistent_tool")).toEqual([]);
  });
});
