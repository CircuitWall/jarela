import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarela-dep-probe-"));
const packagesDir = join(root, "packages");
process.env.JARELA_PACKAGES_DIR = packagesDir;

// Simulated POSIX PATHs must not contain a drive letter on Windows hosts:
// ":" is the PATH separator there.
function forPosix(input: string): string {
  return process.platform === "win32" ? input.replace(/^[A-Za-z]:/, "") : input;
}

function writeInstalledPackage(name: string): void {
  const dir = join(packagesDir, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
  writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
}

writeInstalledPackage("fake-managed-pkg");

const {
  firstMissingDependency,
  getCachedDependencyStatus,
  invalidateDependencyStatuses,
  missingDependencies,
  missingDependencyMessage,
  probeDependency,
  summarizeDependencies,
  _resetDependencyCache,
} = await import("./probe");

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  delete process.env.JARELA_PACKAGES_DIR;
});

describe("probeDependency", () => {
  it("reports a managed node package that resolves", async () => {
    const status = await probeDependency({ kind: "node-package", id: "fake-managed-pkg" }, { force: true });
    expect(status).toMatchObject({ kind: "node-package", state: "satisfied", installable: true, scope: "managed" });
  });

  it("reports a managed node package that does not resolve", async () => {
    const status = await probeDependency({ kind: "node-package", id: "missing-managed-pkg" }, { force: true });
    expect(status).toMatchObject({ kind: "node-package", state: "missing", installable: true });
  });

  it("detects executables on the supplied PATH", async () => {
    const bin = forPosix(join(root, "bin"));
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "fake-cli"), "#!/bin/sh\n");
    chmodSync(join(bin, "fake-cli"), 0o755);
    _resetDependencyCache();

    const found = await probeDependency(
      { kind: "executable", id: "fake-cli" },
      { force: true, env: { PATH: bin }, platform: "linux" },
    );
    const absent = await probeDependency(
      { kind: "executable", id: "fake-cli" },
      { force: true, env: { PATH: forPosix(join(root, "empty")) }, platform: "linux" },
    );

    expect(found).toMatchObject({ state: "satisfied", detail: "on-path", installable: false });
    expect(absent).toMatchObject({ state: "missing", detail: "not-on-path", installable: false });
  });

  it("checks the running Node version", async () => {
    const major = process.versions.node.split(".")[0];
    const satisfied = await probeDependency(
      { kind: "node-runtime", id: "node", version: `^${major}.0.0` },
      { force: true },
    );
    const missing = await probeDependency(
      { kind: "node-runtime", id: "node", version: "^999.0.0" },
      { force: true },
    );
    expect(satisfied.state).toBe("satisfied");
    expect(missing).toMatchObject({ state: "missing", installable: false });
  });

  it("returns unverified for a range it cannot parse", async () => {
    const status = await probeDependency(
      { kind: "node-runtime", id: "node", version: "not-a-range" },
      { force: true },
    );
    expect(status).toMatchObject({ state: "unverified", detail: "invalid-range" });
  });

  it("reuses the cache and re-probes after invalidation", async () => {
    const bin = forPosix(join(root, "late-bin"));
    mkdirSync(bin, { recursive: true });
    const spec = { kind: "executable", id: "late-cli" } as const;
    const env = { PATH: bin };

    expect((await probeDependency(spec, { force: true, env, platform: "linux" })).state).toBe("missing");
    writeFileSync(join(bin, "late-cli"), "#!/bin/sh\n");
    chmodSync(join(bin, "late-cli"), 0o755);

    // Cached verdict survives a filesystem change until something invalidates it.
    expect((await probeDependency(spec, { env, platform: "linux" })).state).toBe("missing");
    invalidateDependencyStatuses();
    expect((await probeDependency(spec, { env, platform: "linux" })).state).toBe("satisfied");
  });
});

describe("dependency status helpers", () => {
  it("returns unverified before the first probe instead of blocking", () => {
    _resetDependencyCache();
    const status = getCachedDependencyStatus({ kind: "node-package", id: "never-probed-pkg" });
    expect(status).toMatchObject({ state: "unverified", detail: "not-probed", installable: true });
  });

  it("serves the cached verdict once a probe has run", async () => {
    _resetDependencyCache();
    await probeDependency({ kind: "node-package", id: "fake-managed-pkg" }, { force: true });
    expect(getCachedDependencyStatus({ kind: "node-package", id: "fake-managed-pkg" }).state).toBe("satisfied");
  });
  it("ignores optional dependencies when summarizing", async () => {
    const [optionalMissing, requiredPresent] = await Promise.all([
      probeDependency({ kind: "executable", id: "nope", required: false }, { force: true, env: { PATH: "" } }),
      probeDependency({ kind: "node-package", id: "fake-managed-pkg" }, { force: true }),
    ]);
    expect(summarizeDependencies([optionalMissing, requiredPresent])).toBe("ready");
    expect(missingDependencies([optionalMissing, requiredPresent])).toHaveLength(0);
    expect(firstMissingDependency([optionalMissing, requiredPresent])).toBeNull();
  });

  it("reports unverified separately from missing", async () => {
    const unverified = await probeDependency(
      { kind: "node-runtime", id: "node", version: "not-a-range" },
      { force: true },
    );
    expect(summarizeDependencies([unverified])).toBe("unverified");
    expect(missingDependencies([unverified])).toHaveLength(0);
  });

  it("prefers the hint in the user-facing message", async () => {
    const status = await probeDependency(
      { kind: "executable", id: "nope", hint: "Install nope from nope.dev" },
      { force: true, env: { PATH: "" } },
    );
    expect(missingDependencyMessage(status)).toContain("Install nope from nope.dev");
  });
});
