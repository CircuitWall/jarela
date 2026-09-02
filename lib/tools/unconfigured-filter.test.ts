import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-unconfigured-"));
const toolsDir = join(tmpRoot, "tools");
mkdirSync(toolsDir, { recursive: true });
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
process.env.JARELA_TOOLS_DIR = toolsDir;

writeFileSync(
  join(toolsDir, "needs_key.cjs"),
  `module.exports = {
    name: "needs_key_tool",
    description: "requires a credential",
    schema: { type: "object", properties: {} },
    credentials_required: ["JARELA_TEST_MISSING_KEY"],
    run: async () => ({ ok: true }),
  };`,
);

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { getAllToolCatalogAsync, applyAgentPermissionsToCatalog } = await import("./index");
const { _resetExternalCache } = await import("./external");
const { _setIntegrationReadiness, invalidateIntegrationReadiness } = await import("@/lib/health/probe-cache");

const agentCfg = { tools: JSON.stringify(["gmail_search", "needs_key_tool"]) };

async function catalogEntry(name: string) {
  return (await getAllToolCatalogAsync()).find((t) => t.name === name);
}

async function permissionEntry(name: string) {
  const permissions = applyAgentPermissionsToCatalog(await getAllToolCatalogAsync(), agentCfg);
  return permissions.find((t) => t.name === name);
}

describe("unconfigured tool filtering", () => {
  beforeEach(() => {
    _resetExternalCache();
    invalidateIntegrationReadiness();
    delete process.env.JARELA_TEST_MISSING_KEY;
  });

  it("keeps unconfigured tools listed in the catalog so they stay discoverable", async () => {
    _setIntegrationReadiness("gmail", "unconfigured");

    // status drives GET /api/v1/tools, which the operator browses in order to
    // set the integration up in the first place.
    expect(await catalogEntry("gmail_search")).toMatchObject({ status: "enabled" });
    expect(await catalogEntry("needs_key_tool")).toMatchObject({ status: "enabled" });
  });

  it("denies a tool whose declared credential is unset", async () => {
    expect(await permissionEntry("needs_key_tool")).toMatchObject({
      permission: "unavailable",
      permission_reason: "credentials_missing",
    });
  });

  it("grants the tool once the credential is present in the environment", async () => {
    process.env.JARELA_TEST_MISSING_KEY = "set";
    _resetExternalCache();

    expect(await permissionEntry("needs_key_tool")).toMatchObject({ permission: "enabled" });
  });

  it("denies integration tools when the cached probe says unconfigured", async () => {
    _setIntegrationReadiness("gmail", "unconfigured");

    expect(await permissionEntry("gmail_search")).toMatchObject({
      permission: "unavailable",
      permission_reason: "integration_unconfigured",
    });
  });

  it("grants integration tools while the probe result is unknown", async () => {
    expect(await permissionEntry("gmail_search")).toMatchObject({ permission: "enabled" });
  });

  it("grants integration tools once the probe reports ready", async () => {
    _setIntegrationReadiness("gmail", "ready");

    expect(await permissionEntry("gmail_search")).toMatchObject({ permission: "enabled" });
  });

  it("records the backing integration on built-in integration tools", async () => {
    expect(await catalogEntry("gmail_search")).toMatchObject({ integration: "gmail" });
    expect(await catalogEntry("memory_read")).toMatchObject({ integration: null });
  });
});
