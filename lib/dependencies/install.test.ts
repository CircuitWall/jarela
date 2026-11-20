import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const root = mkdtempSync(join(tmpdir(), "jarela-dep-install-"));
const packagesDir = join(root, "packages");
mkdirSync(packagesDir, { recursive: true });
process.env.JARELA_PACKAGES_DIR = packagesDir;

/** Materialize a fake installed package under the managed packages dir. */
function writePackage(name: string): void {
  const dir = join(packagesDir, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
  writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
}

writePackage("@langchain/ready");

const { registerTools, unregisterTools } = await import("@/lib/tools/runtime/registry");
const { installDependencies, _setInstallRunnerForTests } = await import("./install");
const { _resetLangChainPackages } = await import("@/lib/tools/packages/langchain-packages");
const { listPendingInstalls, _resetPackageInstallStore } = await import("@/lib/tools/packages/package-install");
const { invalidateDependencyStatuses } = await import("./probe");

function makeTool(name: string) {
  return tool(async () => "ok", { name, description: `test tool ${name}`, schema: z.object({}) });
}

const TOOLS = {
  ready: "dep_install_ready",
  allowlisted: "dep_install_allowlisted",
  failing: "dep_install_failing",
  unlisted: "dep_install_unlisted",
  global: "dep_install_global",
} as const;

registerTools("Web", "read", [makeTool(TOOLS.ready)], undefined, [
  { kind: "node-package", id: "@langchain/ready" },
]);
registerTools("Web", "read", [makeTool(TOOLS.allowlisted)], undefined, [
  { kind: "node-package", id: "@langchain/community" },
]);
registerTools("Web", "read", [makeTool(TOOLS.failing)], undefined, [
  { kind: "node-package", id: "@langchain/failing" },
]);
registerTools("Web", "read", [makeTool(TOOLS.unlisted)], undefined, [
  { kind: "node-package", id: "some-unlisted-pkg" },
]);
registerTools("Web", "read", [makeTool(TOOLS.global)], undefined, [
  { kind: "node-package", id: "@acme/jarela-test-cli", scope: "global", bin: "jarela-test-cli-xyz" },
]);

/** Stand-in for npm: records the call and materializes the package. */
function fakeRunner() {
  const calls: Array<{ command: string[]; cwd: string | null }> = [];
  const run = async (command: string[], cwd: string | null) => {
    calls.push({ command, cwd });
    const spec = command[command.length - 1]!.replace(/@[^@/]+$/, "");
    writePackage(spec);
  };
  return { calls, run };
}

afterEach(() => {
  _setInstallRunnerForTests(null);
  invalidateDependencyStatuses();
  _resetPackageInstallStore();
});

afterAll(() => {
  unregisterTools(Object.values(TOOLS));
  _resetLangChainPackages();
  delete process.env.JARELA_PACKAGES_DIR;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("installDependencies", () => {
  it("reports already_ready without running anything", async () => {
    const fake = fakeRunner();
    _setInstallRunnerForTests(fake.run);

    const outcome = await installDependencies({ kind: "tool", id: TOOLS.ready }, { timeoutMs: 1000 });

    expect(outcome.status).toBe("already_ready");
    expect(fake.calls).toHaveLength(0);
  });

  it("installs an allowlisted managed package and re-probes", async () => {
    const fake = fakeRunner();
    _setInstallRunnerForTests(fake.run);

    const outcome = await installDependencies({ kind: "tool", id: TOOLS.allowlisted }, { timeoutMs: 1000 });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.cwd).toBe(packagesDir);
    expect(outcome.status).toBe("installed");
    expect(outcome.result.status).toBe("ready");
    expect(outcome.ran[0]!.command).toContain("@langchain/community");
  });

  it("queues a non-allowlisted managed package for approval instead of running it", async () => {
    const fake = fakeRunner();
    _setInstallRunnerForTests(fake.run);

    const outcome = await installDependencies({ kind: "tool", id: TOOLS.unlisted }, { timeoutMs: 1000 });

    expect(fake.calls).toHaveLength(0);
    expect(outcome.status).toBe("pending_approval");
    expect(outcome.pending).toHaveLength(1);
    expect(listPendingInstalls().map((p) => p.spec)).toContain("some-unlisted-pkg");
  });

  it("refuses a non-allowlisted global install and returns the command", async () => {
    const fake = fakeRunner();
    _setInstallRunnerForTests(fake.run);

    const outcome = await installDependencies({ kind: "tool", id: TOOLS.global }, { timeoutMs: 1000 });

    expect(fake.calls).toHaveLength(0);
    expect(outcome.status).toBe("blocked");
    expect(outcome.blocked[0]!.step.command).toEqual([
      "npm", "install", "-g", "--no-fund", "--no-audit", "@acme/jarela-test-cli",
    ]);
    expect(outcome.error).toContain("not allowlisted");
  });

  it("reports a runner failure without claiming success", async () => {
    _setInstallRunnerForTests(async () => {
      throw new Error("npm exited 1: EACCES");
    });

    const outcome = await installDependencies({ kind: "tool", id: TOOLS.failing }, { timeoutMs: 1000 });

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("EACCES");
  });

  it("fails an unknown target explicitly", async () => {
    const outcome = await installDependencies({ kind: "tool", id: "does_not_exist" }, { timeoutMs: 1000 });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("unknown dependency target");
  });
});
