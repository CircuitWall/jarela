import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const root = mkdtempSync(join(tmpdir(), "jarela-dep-gate-"));
const packagesDir = join(root, "packages");
mkdirSync(packagesDir, { recursive: true });
process.env.JARELA_PACKAGES_DIR = packagesDir;

const { registerTools, unregisterTools } = await import("@/lib/tools/runtime/registry");
const { gateEnable } = await import("./gate");
const { _setInstallRunnerForTests } = await import("./install");
const { invalidateDependencyStatuses } = await import("./probe");

function makeTool(name: string) {
  return tool(async () => "ok", { name, description: `test tool ${name}`, schema: z.object({}) });
}

registerTools("Web", "read", [makeTool("gate_installable")], undefined, [
  { kind: "node-package", id: "@langchain/community" },
]);
registerTools("Web", "read", [makeTool("gate_manual")], undefined, [
  { kind: "executable", id: "jarela-test-missing-binary", hint: "Install it from the vendor site" },
]);

afterEach(() => {
  _setInstallRunnerForTests(null);
  invalidateDependencyStatuses();
});

afterAll(() => {
  unregisterTools(["gate_installable", "gate_manual"]);
  delete process.env.JARELA_PACKAGES_DIR;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("gateEnable", () => {
  it("does not enable a feature whose installable dependency is missing", async () => {
    const result = await gateEnable({ kind: "tool", id: "gate_installable" });
    expect(result).toMatchObject({ ok: false, reason: "install_required" });
    expect(result.resolution.steps).toHaveLength(1);
  });

  it("installs on request and then allows the enable", async () => {
    _setInstallRunnerForTests(async (command, cwd) => {
      const spec = command[command.length - 1]!;
      const dir = join(cwd ?? packagesDir, "node_modules", spec);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: spec, version: "1.0.0", main: "index.js" }));
      writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
    });

    const result = await gateEnable(
      { kind: "tool", id: "gate_installable" },
      { installMissing: true, timeoutMs: 1000 },
    );

    expect(result.ok).toBe(true);
    expect(result.install?.status).toBe("installed");
    expect(result.resolution.status).toBe("ready");
  });

  it("reports manual dependencies that Jarela cannot install", async () => {
    const result = await gateEnable({ kind: "tool", id: "gate_manual" }, { installMissing: true });
    expect(result).toMatchObject({ ok: false, reason: "manual" });
    expect(result.install).toBeNull();
  });

  it("reports unknown targets instead of enabling them", async () => {
    const result = await gateEnable({ kind: "tool", id: "nope" });
    expect(result).toMatchObject({ ok: false, reason: "unknown_target" });
  });

  it("allows a tool with no declared dependencies", async () => {
    registerTools("Web", "read", [makeTool("gate_clear")]);
    try {
      const result = await gateEnable({ kind: "tool", id: "gate_clear" });
      expect(result).toMatchObject({ ok: true, reason: "ready" });
    } finally {
      unregisterTools(["gate_clear"]);
    }
  });
});
