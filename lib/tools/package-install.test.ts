import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
