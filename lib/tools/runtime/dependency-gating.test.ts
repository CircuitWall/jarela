import { afterAll, describe, expect, it } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const { registerTools, unregisterTools } = await import("./registry");
const { executeTool, getAllToolCatalogAsync, applyAgentPermissionsToCatalog } = await import("../index");
const { _setDependencyStatusForTests } = await import("@/lib/dependencies/probe");
const { allBuiltins } = await import("./catalog");

function makeTool(name: string) {
  return tool(async () => "ok", { name, description: `test tool ${name}`, schema: z.object({}) });
}

const installableSpec = { kind: "node-package", id: "@scope/missing-dep" } as const;
const manualSpec = { kind: "executable", id: "missing-bin", hint: "Install missing-bin from the vendor site" } as const;
const unverifiedSpec = { kind: "node-package", id: "@scope/unknown-state" } as const;

registerTools("Web", "read", [makeTool("dep_gate_installable")], undefined, [installableSpec]);
registerTools("Web", "read", [makeTool("dep_gate_manual")], undefined, [manualSpec]);
registerTools("Web", "read", [makeTool("dep_gate_unverified")], undefined, [unverifiedSpec]);
registerTools("Web", "read", [makeTool("dep_gate_clear")]);

_setDependencyStatusForTests(installableSpec, "missing");
_setDependencyStatusForTests(manualSpec, "missing");
_setDependencyStatusForTests(unverifiedSpec, "unverified");

afterAll(() => {
  unregisterTools(["dep_gate_installable", "dep_gate_manual", "dep_gate_unverified", "dep_gate_clear"]);
});

const cfg = {
  tools: JSON.stringify(["dep_gate_installable", "dep_gate_manual", "dep_gate_unverified", "dep_gate_clear"]),
};

async function permissionFor(name: string) {
  const catalog = await getAllToolCatalogAsync();
  return applyAgentPermissionsToCatalog(catalog, cfg).find((t) => t.name === name);
}

describe("dependency gating", () => {
  it("exposes probed dependencies on catalog entries", async () => {
    const entry = (await getAllToolCatalogAsync()).find((t) => t.name === "dep_gate_installable");
    expect(entry?.dependencies).toEqual([
      expect.objectContaining({ kind: "node-package", id: "@scope/missing-dep", state: "missing" }),
    ]);
    expect(entry?.status).toBe("enabled");
  });

  it("marks a tool with a missing installable dependency unavailable", async () => {
    expect(await permissionFor("dep_gate_installable")).toMatchObject({
      permission: "unavailable",
      permission_reason: "dependency_missing",
    });
  });

  it("distinguishes dependencies the operator must install themselves", async () => {
    expect(await permissionFor("dep_gate_manual")).toMatchObject({
      permission: "unavailable",
      permission_reason: "dependency_manual",
    });
  });

  it("never hides a tool whose dependency state is unverified", async () => {
    expect(await permissionFor("dep_gate_unverified")).toMatchObject({ permission: "enabled" });
  });

  it("keeps self-contained tools enabled", async () => {
    const entry = (await getAllToolCatalogAsync()).find((t) => t.name === "dep_gate_clear");
    expect(entry?.dependencies).toEqual([]);
    expect(await permissionFor("dep_gate_clear")).toMatchObject({ permission: "enabled" });
  });

  it("refuses to execute a tool whose dependency is missing", async () => {
    await expect(executeTool("dep_gate_installable", {})).rejects.toThrow(/unavailable/i);
    await expect(executeTool("dep_gate_manual", {})).rejects.toThrow(/Install missing-bin from the vendor site/);
  });

  it("executes a self-contained tool", async () => {
    await expect(executeTool("dep_gate_clear", {})).resolves.toBe("ok");
  });

  it("keeps the built-in registry intact for other tools", () => {
    expect(allBuiltins().some((t) => t.name === "memory_read")).toBe(true);
  });
});
