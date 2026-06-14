import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-pkg-install-"));
const packagesDir = join(tmpRoot, "packages");
mkdirSync(packagesDir, { recursive: true });
process.env.JARELA_DB_DIR = tmpRoot;
process.env.JARELA_PACKAGES_DIR = packagesDir;

// Capture every `npm install` invocation so we can assert the install
// pipeline passes the flags that v1.10.0 added (cross-spawn for the
// Windows EINVAL trap, --legacy-peer-deps for ERESOLVE on the LangChain
// stack). The mocked child emits a synchronous success.
interface SpawnCall { args: string[]; cwd: string }
const spawnCalls: SpawnCall[] = [];
vi.mock("cross-spawn", () => {
  return {
    default: (cmd: string, args: string[], opts: { cwd: string }) => {
      spawnCalls.push({ args: [cmd, ...args], cwd: opts.cwd });
      const child = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        stdout: EventEmitter;
      };
      child.stderr = new EventEmitter();
      child.stdout = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  };
});

const {
  beginInstall,
  approvePackageInstall,
  denyPackageInstall,
  listPendingInstalls,
  introspectPackage,
  _pendingDirForTest,
  _resetPackageInstallStore,
} = await import("./package-install");

beforeEach(() => {
  _resetPackageInstallStore();
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("beginInstall trust gating", () => {
  it("returns pending for a disallowed publisher", async () => {
    const outcome = await beginInstall({ spec: "@untrusted/pkg" });
    expect(outcome.status).toBe("pending");
    if (outcome.status !== "pending") return;
    expect(outcome.pending.publisher).toBe("@untrusted");
    expect(outcome.pending.spec).toBe("@untrusted/pkg");
    expect(outcome.allowDecision.allowed).toBe(false);

    const onDisk = readdirSync(_pendingDirForTest());
    expect(onDisk).toContain(`${outcome.pending.id}.json`);
  });

  it("rejects empty spec", async () => {
    await expect(beginInstall({ spec: "   " })).rejects.toThrow(/spec is required/);
  });
});

describe("pending install lifecycle", () => {
  it("lists, denies, and removes pending records", async () => {
    const a = await beginInstall({ spec: "@untrusted/a" });
    const b = await beginInstall({ spec: "@untrusted/b" });
    expect(a.status).toBe("pending");
    expect(b.status).toBe("pending");

    const before = listPendingInstalls();
    expect(before.map((p) => p.spec).sort()).toEqual(["@untrusted/a", "@untrusted/b"]);

    if (a.status !== "pending") return;
    const removed = denyPackageInstall(a.pending.id);
    expect(removed).toBe(true);
    expect(listPendingInstalls().map((p) => p.spec)).toEqual(["@untrusted/b"]);
  });

  it("approvePackageInstall throws on unknown id", async () => {
    await expect(approvePackageInstall("does-not-exist")).rejects.toThrow(/unknown approval id/);
  });

  it("denyPackageInstall returns false for unknown id", () => {
    expect(denyPackageInstall("does-not-exist")).toBe(false);
  });
});

describe("introspectPackage", () => {
  it("finds StructuredTool exports from a fake package", async () => {
    const fakePkg = join(packagesDir, "node_modules", "fake-introspect");
    mkdirSync(fakePkg, { recursive: true });
    writeFileSync(
      join(fakePkg, "package.json"),
      JSON.stringify({ name: "fake-introspect", main: "index.cjs" }),
    );
    writeFileSync(
      join(fakePkg, "index.cjs"),
      `class FakeIntrospectTool {
        constructor() {
          this.name = "fake_introspect_tool";
          this.description = "Tool used by introspectPackage tests";
          this.schema = { _def: { typeName: "ZodObject" } };
        }
        async invoke() { return "ok"; }
      }
      class NotATool {}
      module.exports = { FakeIntrospectTool, NotATool };`,
    );

    const tools = await introspectPackage(packagesDir, "fake-introspect");
    const names = tools.map((t) => t.name);
    expect(names).toContain("fake_introspect_tool");
    expect(names).not.toContain("NotATool");
    const tool = tools.find((t) => t.name === "fake_introspect_tool");
    expect(tool?.export).toBe("FakeIntrospectTool");
    expect(tool?.description).toBe("Tool used by introspectPackage tests");
  });

  it("surfaces process.env reads as requiredEnv guesses", async () => {
    const fakePkg = join(packagesDir, "node_modules", "fake-env");
    mkdirSync(fakePkg, { recursive: true });
    writeFileSync(
      join(fakePkg, "package.json"),
      JSON.stringify({ name: "fake-env", main: "index.cjs" }),
    );
    writeFileSync(
      join(fakePkg, "index.cjs"),
      `class FakeEnvTool {
        constructor() {
          this.name = "fake_env_tool";
          this.description = "Reads env";
          this.schema = { _def: { typeName: "ZodObject" } };
          this.key = process.env.FAKE_API_KEY;
          this.other = process.env.FAKE_OTHER_TOKEN;
        }
        async invoke() { return "ok"; }
      }
      module.exports = { FakeEnvTool };`,
    );

    const tools = await introspectPackage(packagesDir, "fake-env");
    const tool = tools.find((t) => t.name === "fake_env_tool");
    expect(tool?.requiredEnv).toContain("FAKE_API_KEY");
    expect(tool?.requiredEnv).toContain("FAKE_OTHER_TOKEN");
  });

  it("returns [] when the package is not installed", async () => {
    const result = await introspectPackage(packagesDir, "definitely-not-installed");
    expect(result).toEqual([]);
  });
});

// Sanity: pendingDir is under packagesDir.
describe("_pendingDirForTest", () => {
  it("points inside packagesDir", () => {
    const dir = _pendingDirForTest();
    expect(dir.startsWith(packagesDir)).toBe(true);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // touch to ensure cleanup-safe
    const probe = join(dir, "probe.txt");
    writeFileSync(probe, "x");
    expect(readFileSync(probe, "utf8")).toBe("x");
  });
});

// Regression tests for v1.10.0 / v1.10.1 install pipeline:
//   - spawn must go through cross-spawn (Windows EINVAL on npm.cmd shim)
//   - npm args must include --legacy-peer-deps (LangChain ERESOLVE)
//   - a successful install must reload manifests so stale "cannot resolve"
//     errors from a manifest saved before the package existed clear out
describe("runInstall pipeline (trusted publisher)", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    // Lay down a fake @langchain/sample package the post-install
    // introspectPackage call will find. Mocked npm doesn't write disk.
    const pkgRoot = join(packagesDir, "node_modules", "@langchain", "sample");
    rmSync(pkgRoot, { recursive: true, force: true });
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "@langchain/sample", version: "9.9.9", main: "index.cjs" }),
    );
    writeFileSync(
      join(pkgRoot, "index.cjs"),
      `class SampleTool {
        constructor() {
          this.name = "sample_tool";
          this.description = "sample";
          this.schema = { _def: { typeName: "ZodObject" } };
        }
        async invoke() { return "ok"; }
      }
      module.exports = { SampleTool };`,
    );
  });

  it("invokes npm via cross-spawn with --legacy-peer-deps and --save", async () => {
    const outcome = await beginInstall({ spec: "@langchain/sample" });
    expect(outcome.status).toBe("installed");

    expect(spawnCalls).toHaveLength(1);
    const [call] = spawnCalls;
    expect(call.args[0]).toBe("npm");
    expect(call.args).toContain("install");
    expect(call.args).toContain("--legacy-peer-deps");
    expect(call.args).toContain("--save");
    expect(call.args).toContain("@langchain/sample");
    expect(call.cwd).toBe(packagesDir);
  });

  it("appends the version to the spec when one is supplied", async () => {
    await beginInstall({ spec: "@langchain/sample", version: "1.2.3" });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args).toContain("@langchain/sample@1.2.3");
  });

  it("clears a stale 'cannot resolve' manifest error after the install", async () => {
    const { reloadLangChainPackages } = await import("./langchain-packages");
    // Use a name that no prior test touched so Node's resolve caches
    // can't paper over the "package missing" state.
    const stalePkg = "@langchain/stale-sample";
    const stalePkgRoot = join(packagesDir, "node_modules", "@langchain", "stale-sample");
    const manifestsDir = join(packagesDir, "manifests");
    mkdirSync(manifestsDir, { recursive: true });
    writeFileSync(
      join(manifestsDir, "stale.json"),
      JSON.stringify({
        package: stalePkg,
        export: "StaleTool",
        category: "Web",
        capability: "read",
      }),
    );

    // Pre-stage the package the mocked npm would have written. We can't
    // assert the "before install" load error here — Node's internal
    // require.resolve cache treats a once-missing scoped package as
    // missing for the lifetime of the worker, so the loader would keep
    // failing even after the directory appears. The install pipeline
    // itself isn't sensitive to this (introspectPackage runs in the
    // same worker but on the freshly-staged tree just like in prod).
    mkdirSync(stalePkgRoot, { recursive: true });
    writeFileSync(
      join(stalePkgRoot, "package.json"),
      JSON.stringify({ name: stalePkg, version: "9.9.9", main: "index.cjs" }),
    );
    writeFileSync(
      join(stalePkgRoot, "index.cjs"),
      `class StaleTool {
        constructor() {
          this.name = "stale_tool";
          this.description = "stale-sample";
          this.schema = { _def: { typeName: "ZodObject" } };
        }
        async invoke() { return "ok"; }
      }
      module.exports = { StaleTool };`,
    );

    const outcome = await beginInstall({ spec: stalePkg });
    expect(outcome.status).toBe("installed");
    if (outcome.status !== "installed") return;
    expect(outcome.result.tools.map((t) => t.name)).toContain("stale_tool");

    // beginInstall → runInstall → reloadLangChainPackages() should now
    // have re-registered the manifest. Calling reload again here just
    // exposes the same cached result.
    const after = await reloadLangChainPackages();
    expect(after.errors.find((e) => e.manifest === "stale.json")).toBeUndefined();
    expect(after.registered).toContain("stale_tool");

    rmSync(join(manifestsDir, "stale.json"), { force: true });
  });
});

