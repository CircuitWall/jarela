import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const root = mkdtempSync(join(tmpdir(), "jarela-dep-plan-"));
const packagesDir = join(root, "packages");
mkdirSync(packagesDir, { recursive: true });
process.env.JARELA_PACKAGES_DIR = packagesDir;

const { registerTools, unregisterTools } = await import("@/lib/tools/runtime/registry");
const { buildInstallStep, formatTarget, parseTarget, resolveDependencies } = await import("./plan");
const { invalidateDependencyStatuses, probeDependency } = await import("./probe");

function makeTool(name: string) {
  return tool(async () => "ok", {
    name,
    description: `test tool ${name}`,
    schema: z.object({}),
  });
}

registerTools("Web", "read", [makeTool("dep_managed_tool")], undefined, [
  { kind: "node-package", id: "@langchain/community" },
]);
registerTools("Web", "read", [makeTool("dep_runtime_tool")], undefined, [
  { kind: "node-runtime", id: "node", version: "^999.0.0", hint: "Install a newer Node" },
]);
registerTools("Web", "read", [makeTool("dep_free_tool")]);

afterAll(() => {
  unregisterTools(["dep_managed_tool", "dep_runtime_tool", "dep_free_tool"]);
  invalidateDependencyStatuses();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  delete process.env.JARELA_PACKAGES_DIR;
});

describe("parseTarget", () => {
  it("parses every supported target kind", () => {
    expect(parseTarget("tool:web_search")).toEqual({ kind: "tool", id: "web_search" });
    expect(parseTarget("integration:gmail")).toEqual({ kind: "integration", id: "gmail" });
    expect(parseTarget("package:github")).toEqual({ kind: "package", id: "github" });
    expect(parseTarget("manifest:tavily")).toEqual({ kind: "manifest", id: "tavily" });
    expect(parseTarget("mcp:time")).toEqual({ kind: "mcp", id: "time" });
  });

  it("rejects malformed or unsupported targets", () => {
    expect(parseTarget("tool")).toBeNull();
    expect(parseTarget("tool:")).toBeNull();
    expect(parseTarget("unknown:thing")).toBeNull();
  });

  it("round-trips through formatTarget", () => {
    expect(formatTarget({ kind: "tool", id: "web_search" })).toBe("tool:web_search");
  });
});

describe("resolveDependencies", () => {
  it("treats a tool without declarations as ready", async () => {
    const resolution = await resolveDependencies({ kind: "tool", id: "dep_free_tool" });
    expect(resolution).toMatchObject({ status: "ready", dependencies: [], steps: [], manual: [] });
  });

  it("reports a missing installable package as install_required", async () => {
    const resolution = await resolveDependencies({ kind: "tool", id: "dep_managed_tool" }, { force: true });
    expect(resolution.status).toBe("install_required");
    expect(resolution.steps).toHaveLength(1);
    expect(resolution.steps[0]).toMatchObject({ cwd: packagesDir, allowlisted: true, publisher: "@langchain" });
    expect(resolution.steps[0]!.command).toEqual([
      "npm", "install", "--save", "--no-fund", "--no-audit", "@langchain/community",
    ]);
  });

  it("reports a missing manual dependency as manual", async () => {
    const resolution = await resolveDependencies({ kind: "tool", id: "dep_runtime_tool" }, { force: true });
    expect(resolution.status).toBe("manual");
    expect(resolution.steps).toHaveLength(0);
    expect(resolution.manual[0]).toMatchObject({ kind: "node-runtime", hint: "Install a newer Node" });
  });

  it("reports unknown targets instead of assuming readiness", async () => {
    expect((await resolveDependencies({ kind: "tool", id: "no_such_tool" })).status).toBe("unknown_target");
    expect((await resolveDependencies({ kind: "integration", id: "no_such_integration" })).status)
      .toBe("unknown_target");
    expect((await resolveDependencies({ kind: "package", id: "no_such_package" })).status)
      .toBe("unknown_target");
  });

  it("resolves bundled package dependencies from the managed location", async () => {
    const resolution = await resolveDependencies({ kind: "package", id: "github" }, { force: true });
    expect(resolution.status).toBe("install_required");
    expect(resolution.steps[0]!.spec).toMatchObject({
      kind: "node-package",
      id: "@circuitwall/github-langchain",
      scope: "workspace",
    });
  });

  it("maps a manifest to its own package plus declared extras", async () => {
    const { getManifestsDir } = await import("@/lib/tools/packages/langchain-packages");
    const { mkdirSync: mk, writeFileSync: write } = await import("node:fs");
    const dir = getManifestsDir();
    mk(dir, { recursive: true });
    write(
      join(dir, "dep-probe-manifest.json"),
      JSON.stringify({
        package: "@langchain/community/tools/tavily_search",
        export: "TavilySearchResults",
        category: "Web",
        dependencies: [{ kind: "executable", id: "jarela-manifest-extra" }],
      }),
    );

    try {
      const resolution = await resolveDependencies({ kind: "manifest", id: "dep-probe-manifest" }, { force: true });
      expect(resolution.status).not.toBe("unknown_target");
      expect(resolution.dependencies.map((d) => `${d.kind}:${d.id}`)).toEqual([
        "node-package:@langchain/community",
        "executable:jarela-manifest-extra",
      ]);
    } finally {
      rmSync(join(dir, "dep-probe-manifest.json"), { force: true });
    }
  });

  it("derives MCP runtime dependencies from the stdio command", async () => {
    const { upsertMcpServer, deleteMcpServer } = await import("@/lib/stores/mcp-servers");
    upsertMcpServer({
      name: "dep-probe-mcp",
      transport: "stdio",
      spec: { command: "uvx", args: ["mcp-server-time"] },
      enabled: true,
    });

    try {
      const resolution = await resolveDependencies({ kind: "mcp", id: "dep-probe-mcp" }, { force: true });
      expect(resolution.dependencies).toEqual([
        expect.objectContaining({ kind: "executable", id: "uvx" }),
      ]);
      expect(["ready", "manual"]).toContain(resolution.status);
    } finally {
      deleteMcpServer("dep-probe-mcp");
    }
  });

  it("reports unknown MCP servers", async () => {
    expect((await resolveDependencies({ kind: "mcp", id: "no-such-mcp" })).status).toBe("unknown_target");
  });

  it("resolves an on-demand runtime target by package name", async () => {
    const resolution = await resolveDependencies(
      { kind: "runtime", id: "@huggingface/transformers" },
      { force: true },
    );
    expect(resolution.status).toBe("install_required");
    expect(resolution.steps[0]!.spec).toMatchObject({
      kind: "node-package",
      id: "@huggingface/transformers",
      scope: "managed",
    });
    expect(resolution.steps[0]!.allowlisted).toBe(true);
  });

  it("rejects an invalid runtime package id", async () => {
    expect((await resolveDependencies({ kind: "runtime", id: "../evil" })).status).toBe("unknown_target");
  });

  it("only allows catalogue runtimes through the runtime target", async () => {
    // A valid, allowlisted package that is not in the optional catalogue must
    // not be installable just by naming it.
    expect((await resolveDependencies({ kind: "runtime", id: "@langchain/community" })).status)
      .toBe("unknown_target");
  });
});

describe("buildInstallStep", () => {
  it("installs managed packages into the packages dir", async () => {
    const spec = { kind: "node-package", id: "@langchain/community" } as const;
    const status = await probeDependency(spec, { force: true });
    const step = buildInstallStep(spec, status);
    expect(step).toMatchObject({ cwd: packagesDir, allowlisted: true, publisher: "@langchain" });
  });

  it("uses a global install for CLI packages", async () => {
    const spec = { kind: "node-package", id: "@openai/codex", scope: "global", bin: "codex" } as const;
    const status = await probeDependency(spec, { force: true, env: { PATH: "" } });
    const step = buildInstallStep(spec, status);
    expect(step).toMatchObject({ cwd: null, allowlisted: false });
    expect(step!.command).toEqual(["npm", "install", "-g", "--no-fund", "--no-audit", "@openai/codex"]);
  });

  it("returns null for kinds Jarela never installs", async () => {
    const spec = { kind: "executable", id: "docker" } as const;
    const status = await probeDependency(spec, { force: true, env: { PATH: "" } });
    expect(buildInstallStep(spec, status)).toBeNull();
  });
});
