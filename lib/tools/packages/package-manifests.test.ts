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
  class AnotherFakeTool {
    constructor() {
      this.name = "another_fake_tool";
      this.description = "Second tool, used for wildcard discovery tests";
      this.schema = { _def: { typeName: "ZodObject" } };
    }
    async invoke() { return "ok"; }
  }
  // Helper export that is NOT a StructuredTool — wildcard discovery
  // must construct it without throwing and then skip it silently.
  class NotATool {
    constructor() { this.name = "not_a_tool"; }
  }
  // Plain helper function — wildcard discovery must skip without
  // calling it as a constructor (it would throw).
  function helperFn() { return 1; }
  module.exports = {
    FakeManifestTool,
    AnotherFakeTool,
    NotATool,
    helperFn,
    default: FakeManifestTool,
  };`,
);

process.env.JARELA_DB_DIR = tmpRoot;
process.env.JARELA_PACKAGES_DIR = packagesDir;

const { _resetLangChainPackages } = await import("./langchain-packages");
const {
  createManifest,
  deleteManifest,
  getManifest,
  listManifests,
  setManifestEnabled,
  isManifestDisabled,
  manifestDisableKey,
  normalizeManifestName,
  _wipeManifests,
} = await import("./package-manifests");
const {
  listDisabledPackages,
  setPackageDisabled,
} = await import("@/lib/stores/disabled-packages");

beforeEach(() => {
  _wipeManifests();
  for (const id of listDisabledPackages()) setPackageDisabled(id, false);
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

  it("clears the disabled flag so a re-install starts enabled", async () => {
    await createManifest({
      name: "toggle-then-delete",
      package: "fake-manifest-pkg",
      export: "FakeManifestTool",
      category: "Web",
    });
    await setManifestEnabled("toggle-then-delete", false);
    expect(isManifestDisabled("toggle-then-delete")).toBe(true);

    await deleteManifest("toggle-then-delete");
    expect(isManifestDisabled("toggle-then-delete")).toBe(false);
  });
});

describe("setManifestEnabled", () => {
  it("defaults manifests to enabled", async () => {
    const { record } = await createManifest({
      name: "default-on",
      package: "fake-manifest-pkg",
      export: "FakeManifestTool",
      category: "Web",
    });
    expect(record.enabled).toBe(true);
  });

  it("disabling a manifest persists the flag and skips it on reload", async () => {
    await createManifest({
      name: "flippy",
      package: "fake-manifest-pkg",
      export: "FakeManifestTool",
      category: "Web",
    });

    const off = await setManifestEnabled("flippy", false);
    expect(off.record.enabled).toBe(false);
    expect(off.load.registered).not.toContain("fake_manifest_tool");
    expect(off.load.skipped.some((s) => s.manifest === "flippy.json")).toBe(true);
    expect(isManifestDisabled("flippy")).toBe(true);

    // listManifests reflects the flag too.
    const row = listManifests().find((r) => r.name === "flippy");
    expect(row?.enabled).toBe(false);
  });

  it("re-enabling a manifest registers the tool again", async () => {
    await createManifest({
      name: "flippy",
      package: "fake-manifest-pkg",
      export: "FakeManifestTool",
      category: "Web",
    });
    await setManifestEnabled("flippy", false);

    const on = await setManifestEnabled("flippy", true);
    expect(on.record.enabled).toBe(true);
    expect(on.load.registered).toContain("fake_manifest_tool");
    expect(isManifestDisabled("flippy")).toBe(false);
  });

  it("throws when the manifest does not exist", async () => {
    await expect(setManifestEnabled("ghost", false)).rejects.toThrow(/not found/);
  });

  it("normalizes the name before lookup", async () => {
    await createManifest({
      name: "Pretty Name",
      package: "fake-manifest-pkg",
      export: "FakeManifestTool",
      category: "Web",
    });
    const out = await setManifestEnabled("Pretty Name", false);
    expect(out.record.name).toBe("pretty-name");
    expect(out.record.enabled).toBe(false);
  });

  it("namespaces its disable key under 'npm:'", async () => {
    await createManifest({
      name: "key-check",
      package: "fake-manifest-pkg",
      export: "FakeManifestTool",
      category: "Web",
    });
    await setManifestEnabled("key-check", false);
    expect(listDisabledPackages()).toContain(manifestDisableKey("key-check"));
    expect(manifestDisableKey("key-check")).toBe("npm:key-check");
  });
});

describe("wildcard export discovery", () => {
  it("registers every StructuredTool-shaped export when export is '*'", async () => {
    const { load } = await createManifest({
      name: "wild",
      package: "fake-manifest-pkg",
      export: "*",
      category: "Web",
    });

    expect(load.errors).toEqual([]);
    expect(load.registered).toEqual(
      expect.arrayContaining(["fake_manifest_tool", "another_fake_tool"]),
    );
  });

  it("dedupes by tool name when the same class is exported twice", async () => {
    // fixture exports `FakeManifestTool` AND `default: FakeManifestTool`,
    // both producing instances with `name = "fake_manifest_tool"`.
    const { load } = await createManifest({
      name: "wild-dedupe",
      package: "fake-manifest-pkg",
      export: "*",
      category: "Web",
    });

    const hits = load.registered.filter((n) => n === "fake_manifest_tool");
    expect(hits.length).toBe(1);
  });

  it("skips non-StructuredTool exports without erroring", async () => {
    const { load } = await createManifest({
      name: "wild-skip",
      package: "fake-manifest-pkg",
      export: "*",
      category: "Web",
    });

    expect(load.errors).toEqual([]);
    expect(load.registered).not.toContain("not_a_tool");
    expect(load.registered).not.toContain("helperFn");
  });
});

