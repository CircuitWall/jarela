import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const root = mkdtempSync(join(tmpdir(), "jarela-ensure-"));
const packagesDir = join(root, "packages");
mkdirSync(packagesDir, { recursive: true });
process.env.JARELA_PACKAGES_DIR = packagesDir;

const { registerTools, unregisterTools } = await import("@/lib/tools/runtime/registry");
const { ensureTarget, getEnsureOutcome, ensureTargets, _resetEnsureState } = await import("./ensure");
const { _setInstallRunnerForTests } = await import("./install");
const { invalidateDependencyStatuses } = await import("./probe");

function makeTool(name: string) {
  return tool(async () => "ok", { name, description: `test ${name}`, schema: z.object({}) });
}

let seq = 0;
const registered: string[] = [];

/**
 * Every case gets its own tool and its own allowlisted package id, so one
 * test installing its dependency cannot make the next test start "ready".
 */
function registerTool(depKind: "node-package" | "node-runtime" = "node-package", hint?: string) {
  seq += 1;
  const name = `ensure_tool_${seq}`;
  const spec = depKind === "node-package"
    ? { kind: "node-package" as const, id: `@langchain/ensure-${seq}` }
    : { kind: "node-runtime" as const, id: "node", version: "^999.0.0", ...(hint ? { hint } : {}) };
  registerTools("Web", "read", [makeTool(name)], undefined, [spec]);
  registered.push(name);
  return { name, spec };
}

function fakeRunner() {
  const calls: string[][] = [];
  const run = async (command: string[], cwd: string | null) => {
    calls.push(command);
    const spec = command[command.length - 1]!;
    const dir = join(cwd ?? packagesDir, "node_modules", spec);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: spec, version: "1.0.0", main: "index.js" }));
    writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
  };
  return { calls, run };
}

afterEach(() => {
  _setInstallRunnerForTests(null);
  invalidateDependencyStatuses();
  _resetEnsureState();
});

afterAll(() => {
  unregisterTools(registered);
  delete process.env.JARELA_PACKAGES_DIR;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("ensureTarget", () => {
  it("installs what an enabled tool needs", async () => {
    const fake = fakeRunner();
    _setInstallRunnerForTests(fake.run);
    const { name } = registerTool();

    const outcome = await ensureTarget({ kind: "tool", id: name });

    expect(fake.calls).toHaveLength(1);
    expect(outcome.status).toBe("installed");
    expect(outcome.message).toContain(name);
    expect(getEnsureOutcome({ kind: "tool", id: name })?.status).toBe("installed");
  });

  it("shares one install between concurrent enables", async () => {
    const fake = fakeRunner();
    _setInstallRunnerForTests(fake.run);
    const { name } = registerTool();

    const [a, b] = await Promise.all([
      ensureTarget({ kind: "tool", id: name }),
      ensureTarget({ kind: "tool", id: name }),
    ]);

    expect(fake.calls).toHaveLength(1);
    expect(a.status).toBe("installed");
    expect(b.status).toBe("installed");
  });

  it("reports a manual prerequisite without trying to install it", async () => {
    const fake = fakeRunner();
    _setInstallRunnerForTests(fake.run);
    const { name } = registerTool("node-runtime", "Install a newer Node");

    const outcome = await ensureTarget({ kind: "tool", id: name });

    expect(fake.calls).toHaveLength(0);
    expect(outcome).toMatchObject({ status: "manual", message: "Install a newer Node" });
  });

  it("cools down after a failure and retries when forced", async () => {
    let attempts = 0;
    _setInstallRunnerForTests(async () => {
      attempts += 1;
      throw new Error("npm exited 1: ECONNRESET");
    });
    const { name } = registerTool();

    const first = await ensureTarget({ kind: "tool", id: name });
    expect(first.status).toBe("failed");
    expect(attempts).toBe(1);

    const cooled = await ensureTarget({ kind: "tool", id: name });
    expect(cooled.status).toBe("failed");
    expect(attempts).toBe(1);

    await ensureTarget({ kind: "tool", id: name }, { force: true });
    expect(attempts).toBe(2);
  });

  it("fails an unknown target instead of pretending it is ready", async () => {
    const outcome = await ensureTarget({ kind: "tool", id: "no-such-tool" });
    expect(outcome.status).toBe("failed");
    expect(outcome.message).toContain("not a known target");
  });

  it("ensures several targets without aborting on one failure", async () => {
    const fake = fakeRunner();
    const failing = registerTool();
    const working = registerTool();
    _setInstallRunnerForTests(async (command, cwd) => {
      if (command.includes(failing.spec.id)) throw new Error("npm exited 1: E404");
      await fake.run(command, cwd);
    });

    const outcomes = await ensureTargets([
      { kind: "tool", id: working.name },
      { kind: "tool", id: failing.name },
    ]);

    expect(outcomes.map((o) => o.status)).toEqual(["installed", "failed"]);
  });
});
