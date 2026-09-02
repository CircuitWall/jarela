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

const { getAllToolCatalogAsync } = await import("./index");
const { _resetExternalCache } = await import("./external");
const { _setIntegrationReadiness, invalidateIntegrationReadiness } = await import("@/lib/health/probe-cache");

async function entry(name: string) {
  const catalog = await getAllToolCatalogAsync();
  return catalog.find((t) => t.name === name);
}

describe("unconfigured tool filtering", () => {
  beforeEach(() => {
    _resetExternalCache();
    invalidateIntegrationReadiness();
    delete process.env.JARELA_TEST_MISSING_KEY;
  });

  it("marks a drop-in tool unavailable when its declared credential is unset", async () => {
    expect(await entry("needs_key_tool")).toMatchObject({
      status: "unavailable",
      status_reason: "credentials_missing",
    });
  });

  it("restores the tool once the credential is present in the environment", async () => {
    process.env.JARELA_TEST_MISSING_KEY = "set";
    _resetExternalCache();

    expect(await entry("needs_key_tool")).toMatchObject({ status: "enabled" });
  });

  it("hides integration tools when the cached probe says unconfigured", async () => {
    _setIntegrationReadiness("gmail", "unconfigured");

    expect(await entry("gmail_search")).toMatchObject({
      status: "unavailable",
      status_reason: "integration_unconfigured",
    });
  });

  it("keeps integration tools visible while the probe result is unknown", async () => {
    expect(await entry("gmail_search")).toMatchObject({ status: "enabled" });
  });

  it("keeps integration tools visible once the probe reports ready", async () => {
    _setIntegrationReadiness("gmail", "ready");

    expect(await entry("gmail_search")).toMatchObject({ status: "enabled" });
  });

  it("records the backing integration on built-in integration tools", async () => {
    expect(await entry("gmail_search")).toMatchObject({ integration: "gmail" });
    expect(await entry("memory_read")).toMatchObject({ integration: null });
  });
});
