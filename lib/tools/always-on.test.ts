import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-always-on-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { getAllToolCatalogAsync, executeTool, getAllTools, getAllToolsAsync } = await import("./index");
const { setCategoryEnabled } = await import("@/lib/stores/builtin-tools");

// Disabling Config would otherwise strip list_tools and invoke_tool, which are
// the only route to non-basic tools.
describe("proxy tools survive a disabled Config category", () => {
  it("keeps list_tools and invoke_tool enabled in the catalog", async () => {
    setCategoryEnabled("Config", false);
    try {
      const catalog = await getAllToolCatalogAsync();
      const byName = new Map(catalog.map((t) => [t.name, t]));

      expect(byName.get("invoke_tool")).toMatchObject({ status: "enabled" });
      expect(byName.get("list_tools")).toMatchObject({ status: "enabled" });
      // A non-exempt Config tool still goes away.
      expect(byName.get("propose_config_change")).toMatchObject({
        status: "disabled",
        status_reason: "category_disabled",
      });
    } finally {
      setCategoryEnabled("Config", true);
    }
  });

  it("still executes list_tools while Config is disabled", async () => {
    setCategoryEnabled("Config", false);
    try {
      await expect(executeTool("list_tools", { query: "memory" })).resolves.toBeDefined();
      await expect(executeTool("propose_config_change", {})).rejects.toThrow(/disabled/i);
    } finally {
      setCategoryEnabled("Config", true);
    }
  });

  // Being executable is not enough: if the proxy is never bound to the model
  // it cannot be called, and non-basic tools become unreachable.
  it("still binds the proxy tools to the model while Config is disabled", async () => {
    setCategoryEnabled("Config", false);
    try {
      const sync = getAllTools().map((t) => t.name);
      expect(sync).toContain("invoke_tool");
      expect(sync).toContain("list_tools");
      expect(sync).not.toContain("propose_config_change");

      const async = (await getAllToolsAsync()).map((t) => t.name);
      expect(async).toContain("invoke_tool");
      expect(async).toContain("list_tools");
      expect(async).not.toContain("propose_config_change");
    } finally {
      setCategoryEnabled("Config", true);
    }
  });
});
