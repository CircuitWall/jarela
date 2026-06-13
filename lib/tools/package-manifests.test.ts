import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-pkg-manifests-"));
const packagesDir = join(tmpRoot, "packages");
const manifestsDir = join(packagesDir, "manifests");
const moduleDir = join(packagesDir, "node_modules", "fake-manifest-pkg");
mkdirSync(manifestsDir, { recursive: true });
mkdirSync(moduleDir, { recursive: true });
writeFileSync(
  join(moduleDir, "package.json"),
  JSON.stringify({ name: "fake-manifest-pkg", main: "index.cjs" }),
);
writeFileSync(
  join(moduleDir, "index.cjs"),
  `class FakeManifestTool {
    constructor() {
      this.name = "fake_manifest_tool";
      this.description = "Tool for manifest CRUD tests";
      this.schema = { _def: { typeName: "ZodObject" } };
    }
    async invoke() { return "ok"; }
  }
  module.exports = { FakeManifestTool, default: FakeManifestTool };`,
);

process.env.JARELA_DB_DIR = tmpRoot;
process.env.JARELA_PACKAGES_DIR = packagesDir;

const { _resetLangChainPackages } = await import("./langchain-packages");
const {
  createManifest,
  deleteManifest,
  getManifest,
  listManifests,
  normalizeManifestName,
  _wipeManifests,
} = await import("./package-manifests");

beforeEach(() => {
  _wipeManifests();
  _resetLangChainPackages();
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("normalizeManifestName", () => {
  it("slugifies arbitrary input", () => {
    expect(normalizeManifestName("Tavily Search!")).toBe("tavily-search");
    expect(normalizeManifestName("@langchain/community"))
      .toBe("langchain-community");
    expect(normalizeManifestName("  Wikipedia  ")).toBe("wikipedia");
  });

  it("throws on empty after normalization", () => {
    expect(() => normalizeManifestName("   ")).toThrow(/alphanumeric/);
    expect(() => normalizeManifestName("@@@")).toThrow(/alphanumeric/);
  });
});

describe("createManifest", () => {
  it("writes a manifest file and triggers a reload that registers the tool", async () => {
    const { record, load } = await createManifest({
      name: "Fake Tool",
      package: "fake-manifest-pkg",
      export: "FakeManifestTool",
      category: "Web",
      capability: "read",
    });

    expect(record.name).toBe("fake-tool");
    expect(existsSync(join(manifestsDir, "fake-tool.json"))).toBe(true);

    const on_disk = JSON.parse(readFileSync(join(manifestsDir, "fake-tool.json"), "utf8"));
    expect(on_disk.package).toBe("fake-manifest-pkg");
    expect(on_disk.export).toBe("FakeManifestTool");
    expect(on_disk.capability).toBe("read");

    expect(load.registered).toContain("fake_manifest_tool");
    expect(load.errors).toEqual([]);
  });

  it("defaults export to 'default' and capability to 'execute'", async () => {
    const { record } = await createManifest({
      name: "default-tool",
      package: "fake-manifest-pkg",
      category: "Web",
    });

    expect(record.manifest.export).toBe("default");
    expect(record.manifest.capability).toBe("execute");
  });

  it("rejects duplicate name unless replace=true", async () => {
    await createManifest({
      name: "dup",
      package: "fake-manifest-pkg",
      export: "FakeManifestTool",
      category: "Web",
    });
    await expect(createManifest({
      name: "dup",
      package: "fake-manifest-pkg",
      export: "FakeManifestTool",
      category: "Web",
    })).rejects.toThrow(/already exists/);

    const result = await createManifest({
      name: "dup",
      package: "fake-manifest-pkg",
      export: "FakeManifestTool",
      category: "Web",
      capability: "write",
    }, { replace: true });
    expect(result.record.manifest.capability).toBe("write");
  });

  it("validates input against MANIFEST_INPUT_SCHEMA", async () => {
    await expect(createManifest({
      name: "bad",
      package: "fake-manifest-pkg",
      category: "NotARealCategory" as unknown as "Web",
    })).rejects.toThrow();
  });
});

describe("listManifests", () => {
  it("returns saved manifests sorted by name", async () => {
    await createManifest({
      name: "zeta",
      package: "fake-manifest-pkg",
      export: "FakeManifestTool",
      category: "Web",
    });
    await createManifest({
      name: "alpha",
      package: "fake-manifest-pkg",
      export: "FakeManifestTool",
      category: "Web",
    });

    const rows = listManifests();
    expect(rows.map((r) => r.name)).toEqual(["alpha", "zeta"]);
  });

  it("skips malformed JSON without throwing", () => {
    writeFileSync(join(manifestsDir, "broken.json"), "{ not valid");
    expect(listManifests()).toEqual([]);
  });
});

describe("getManifest", () => {
  it("returns a saved manifest by normalized name", async () => {
    await createManifest({
      name: "Foo Bar",
      package: "fake-manifest-pkg",
      export: "FakeManifestTool",
      category: "Web",
    });
    expect(getManifest("Foo Bar")?.manifest.package).toBe("fake-manifest-pkg");
    expect(getManifest("foo-bar")?.manifest.package).toBe("fake-manifest-pkg");
  });

  it("returns null for unknown name", () => {
    expect(getManifest("missing")).toBeNull();
  });
});

describe("deleteManifest", () => {
  it("removes the file and triggers a reload that drops the tool", async () => {
    await createManifest({
      name: "to-remove",
      package: "fake-manifest-pkg",
      export: "FakeManifestTool",
      category: "Web",
    });

    const { removed, load } = await deleteManifest("to-remove");
    expect(removed).toBe(true);
    expect(existsSync(join(manifestsDir, "to-remove.json"))).toBe(false);
    expect(load.registered).not.toContain("fake_manifest_tool");
  });

  it("returns removed=false for unknown name", async () => {
    const { removed } = await deleteManifest("nope");
    expect(removed).toBe(false);
  });
});
