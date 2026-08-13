import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLangChainPackages,
  reloadLangChainPackages,
  getPackagesDir,
  _resetLangChainPackages,
} from "./langchain-packages";
import { registeredNames, registeredCategory, registeredCapability, _resetRegistry } from "./registry";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-langchain-pkgs-"));
const originalEnv = process.env.JARELA_PACKAGES_DIR;

interface FakeToolSpec {
  packageDir: string;        // node_modules subdir name, e.g. "fake-tool"
  exportName: string;        // e.g. "FakeTool"
  toolName: string;          // name the constructed tool will carry
  description?: string;
}

function setupPackagesDir(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(join(dir, "manifests"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  return dir;
}

function writeFakeModule(packagesDir: string, spec: FakeToolSpec): void {
  const modDir = join(packagesDir, "node_modules", spec.packageDir);
  mkdirSync(modDir, { recursive: true });
  writeFileSync(
    join(modDir, "package.json"),
    JSON.stringify({ name: spec.packageDir, version: "0.0.0", main: "index.cjs" }),
    "utf8",
  );
  const desc = spec.description ?? "fake tool for tests";
  writeFileSync(
    join(modDir, "index.cjs"),
    `
class ${spec.exportName} {
  constructor(opts) {
    this.name = (opts && opts.name) || ${JSON.stringify(spec.toolName)};
    this.description = ${JSON.stringify(desc)};
    this.schema = { type: "object", properties: {}, additionalProperties: true };
  }
  async invoke() { return "ok"; }
}
exports.${spec.exportName} = ${spec.exportName};
`,
    "utf8",
  );
}

function writeManifest(packagesDir: string, file: string, manifest: object): void {
  writeFileSync(join(packagesDir, "manifests", file), JSON.stringify(manifest, null, 2), "utf8");
}

afterAll(() => {
  if (originalEnv === undefined) delete process.env.JARELA_PACKAGES_DIR;
  else process.env.JARELA_PACKAGES_DIR = originalEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("loadLangChainPackages", () => {
  beforeEach(() => {
    _resetRegistry();
    _resetLangChainPackages();
  });

  it("returns empty result when manifests dir does not exist", async () => {
    const dir = join(tmpRoot, "missing");
    mkdirSync(dir, { recursive: true });
    process.env.JARELA_PACKAGES_DIR = dir;

    const result = await loadLangChainPackages();
    expect(result).toEqual({ registered: [], skipped: [], errors: [] });
  });

  it("getPackagesDir honours JARELA_PACKAGES_DIR override", () => {
    process.env.JARELA_PACKAGES_DIR = "/tmp/custom";
    expect(getPackagesDir()).toBe("/tmp/custom");
  });

  it("loads a manifest, instantiates the export, and registers the tool", async () => {
    const dir = setupPackagesDir("ok");
    process.env.JARELA_PACKAGES_DIR = dir;
    writeFakeModule(dir, { packageDir: "fake-a", exportName: "FakeA", toolName: "fake_a" });
    writeManifest(dir, "fake-a.json", {
      package: "fake-a",
      export: "FakeA",
      category: "Web",
      capability: "read",
    });

    const result = await loadLangChainPackages();

    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.registered).toEqual(["fake_a"]);
    expect(registeredNames().has("fake_a")).toBe(true);
    expect(registeredCategory("fake_a")).toBe("Web");
    expect(registeredCapability("fake_a")).toBe("read");
  }, 20_000);

  it("defaults capability to execute when omitted", async () => {
    const dir = setupPackagesDir("default-cap");
    process.env.JARELA_PACKAGES_DIR = dir;
    writeFakeModule(dir, { packageDir: "fake-d", exportName: "FakeD", toolName: "fake_d" });
    writeManifest(dir, "fake-d.json", {
      package: "fake-d",
      export: "FakeD",
      category: "Web",
    });

    await loadLangChainPackages();
    expect(registeredCapability("fake_d")).toBe("execute");
  });

  it("skips manifests with missing required env vars", async () => {
    const dir = setupPackagesDir("envcheck");
    process.env.JARELA_PACKAGES_DIR = dir;
    delete process.env.FAKE_TEST_KEY_THAT_IS_NEVER_SET;
    writeFakeModule(dir, { packageDir: "fake-e", exportName: "FakeE", toolName: "fake_e" });
    writeManifest(dir, "fake-e.json", {
      package: "fake-e",
      export: "FakeE",
      category: "Web",
      capability: "read",
      requiredEnv: ["FAKE_TEST_KEY_THAT_IS_NEVER_SET"],
    });

    const result = await loadLangChainPackages();
    expect(result.registered).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/FAKE_TEST_KEY_THAT_IS_NEVER_SET/);
    expect(registeredNames().has("fake_e")).toBe(false);
  });

  it("records errors when JSON is invalid", async () => {
    const dir = setupPackagesDir("badjson");
    process.env.JARELA_PACKAGES_DIR = dir;
    writeFileSync(join(dir, "manifests", "broken.json"), "{ this is not json", "utf8");

    const result = await loadLangChainPackages();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/invalid JSON/i);
  });

  it("records errors when schema validation fails", async () => {
    const dir = setupPackagesDir("badschema");
    process.env.JARELA_PACKAGES_DIR = dir;
    writeManifest(dir, "bad.json", { package: "x", category: "NotARealCategory" });

    const result = await loadLangChainPackages();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/schema validation/i);
  });

  it("records errors when the package cannot be resolved", async () => {
    const dir = setupPackagesDir("noresolve");
    process.env.JARELA_PACKAGES_DIR = dir;
    writeManifest(dir, "missing.json", {
      package: "this-package-does-not-exist-anywhere",
      export: "Whatever",
      category: "Web",
    });

    const result = await loadLangChainPackages();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/cannot resolve/i);
  });

  it("records errors when the named export is not a function", async () => {
    const dir = setupPackagesDir("notctor");
    process.env.JARELA_PACKAGES_DIR = dir;
    const modDir = join(dir, "node_modules", "fake-n");
    mkdirSync(modDir, { recursive: true });
    writeFileSync(join(modDir, "package.json"), JSON.stringify({ name: "fake-n", main: "index.cjs" }), "utf8");
    writeFileSync(join(modDir, "index.cjs"), `exports.NotAFunction = { hello: "world" };`, "utf8");
    writeManifest(dir, "notfunc.json", {
      package: "fake-n",
      export: "NotAFunction",
      category: "Web",
    });

    const result = await loadLangChainPackages();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/not a function/i);
  });

  it("records errors when the constructed instance is not a StructuredTool", async () => {
    const dir = setupPackagesDir("nottool");
    process.env.JARELA_PACKAGES_DIR = dir;
    const modDir = join(dir, "node_modules", "fake-x");
    mkdirSync(modDir, { recursive: true });
    writeFileSync(join(modDir, "package.json"), JSON.stringify({ name: "fake-x", main: "index.cjs" }), "utf8");
    writeFileSync(
      join(modDir, "index.cjs"),
      `class NotATool { constructor() { this.greeting = "hi"; } }\nexports.NotATool = NotATool;`,
      "utf8",
    );
    writeManifest(dir, "x.json", { package: "fake-x", export: "NotATool", category: "Web" });

    const result = await loadLangChainPackages();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/StructuredTool/);
  });

  it("is idempotent within a single process", async () => {
    const dir = setupPackagesDir("idempotent");
    process.env.JARELA_PACKAGES_DIR = dir;
    writeFakeModule(dir, { packageDir: "fake-i", exportName: "FakeI", toolName: "fake_i" });
    writeManifest(dir, "i.json", { package: "fake-i", export: "FakeI", category: "Web", capability: "read" });

    const first = await loadLangChainPackages();
    const second = await loadLangChainPackages();
    expect(first.registered).toEqual(["fake_i"]);
    // Second call returns the cached result — registration ran once, not
    // twice (which would have thrown on duplicate name). Cached result
    // object is the same instance.
    expect(second).toBe(first);
    expect(registeredNames().has("fake_i")).toBe(true);
  });

  it("reloadLangChainPackages unregisters previous tools then reloads", async () => {
    const dir = setupPackagesDir("reload");
    process.env.JARELA_PACKAGES_DIR = dir;
    writeFakeModule(dir, { packageDir: "fake-r", exportName: "FakeR", toolName: "fake_r" });
    writeManifest(dir, "r.json", { package: "fake-r", export: "FakeR", category: "Web", capability: "read" });

    const first = await loadLangChainPackages();
    expect(first.registered).toEqual(["fake_r"]);
    expect(registeredNames().has("fake_r")).toBe(true);

    const second = await reloadLangChainPackages();
    expect(second.registered).toEqual(["fake_r"]);
    expect(registeredNames().has("fake_r")).toBe(true);
  });

  // Regression: v1.10.1 user hit "Cannot find module 'file:///…/wikipedia_
  // query_run.cjs'" because Next.js's server bundler intercepts dynamic
  // `import()` of `file://` URLs and can't resolve the on-disk module
  // even when it exists. The loader switched to `createRequire` to
  // bypass the bundler; this test covers both a subpath manifest and
  // a `.cjs` extension to guard against a regression to `import()`.
  it("loads a manifest that targets a package subpath with a .cjs extension", async () => {
    const dir = setupPackagesDir("subpath-cjs");
    process.env.JARELA_PACKAGES_DIR = dir;
    const modDir = join(dir, "node_modules", "fake-subpath", "dist", "tools");
    mkdirSync(modDir, { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "fake-subpath", "package.json"),
      JSON.stringify({
        name: "fake-subpath",
        version: "1.0.0",
        exports: {
          ".": "./index.cjs",
          "./tools/wiki": {
            require: "./dist/tools/wiki.cjs",
          },
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(dir, "node_modules", "fake-subpath", "index.cjs"),
      "module.exports = {};",
      "utf8",
    );
    writeFileSync(
      join(modDir, "wiki.cjs"),
      `class FakeWikiTool {
        constructor() {
          this.name = "fake_wiki";
          this.description = "subpath cjs tool";
          this.schema = { type: "object", properties: {}, additionalProperties: true };
        }
        async invoke() { return "ok"; }
      }
      exports.FakeWikiTool = FakeWikiTool;`,
      "utf8",
    );
    writeManifest(dir, "wiki.json", {
      package: "fake-subpath/tools/wiki",
      export: "FakeWikiTool",
      category: "Web",
      capability: "read",
    });

    const result = await loadLangChainPackages();
    expect(result.errors).toEqual([]);
    expect(result.registered).toEqual(["fake_wiki"]);
    expect(registeredNames().has("fake_wiki")).toBe(true);
  });
});
