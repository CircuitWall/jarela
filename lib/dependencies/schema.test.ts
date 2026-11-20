import { describe, expect, it, vi } from "vitest";
import {
  DependencySpecSchema,
  dependencyKey,
  dependencyLabel,
  isRequired,
  packageRootOf,
  parseDependencySpecs,
  safeParseDependencySpecs,
} from "./schema";

describe("DependencySpecSchema", () => {
  it("accepts one representative spec per kind", () => {
    expect(() => DependencySpecSchema.parse({ kind: "node-package", id: "@langchain/community" })).not.toThrow();
    expect(() => DependencySpecSchema.parse({ kind: "executable", id: "uvx" })).not.toThrow();
    expect(() => DependencySpecSchema.parse({ kind: "node-runtime", id: "node", version: "^24.15.0 || >=26.0.0" }))
      .not.toThrow();
  });

  it("rejects fields that belong to another kind", () => {
    expect(() => DependencySpecSchema.parse({ kind: "executable", id: "uvx", scope: "global" })).toThrow(/scope/);
    expect(() => DependencySpecSchema.parse({ kind: "node-runtime", id: "node", version: ">=24", bin: "node" }))
      .toThrow(/bin/);
  });

  it("requires a version range for node-runtime and pins its id", () => {
    expect(() => DependencySpecSchema.parse({ kind: "node-runtime", id: "node" })).toThrow(/version range/);
    expect(() => DependencySpecSchema.parse({ kind: "node-runtime", id: "deno", version: ">=24" })).toThrow(/node-runtime id/);
  });

  it("rejects ids that are paths or shell fragments", () => {
    expect(() => DependencySpecSchema.parse({ kind: "executable", id: "" })).toThrow();
    expect(() => DependencySpecSchema.parse({ kind: "executable", id: "rm -rf /" })).toThrow(/package or binary name/);
    expect(() => DependencySpecSchema.parse({ kind: "node-package", id: "pkg;curl evil" })).toThrow();
    expect(() => DependencySpecSchema.parse({ kind: "node-package", id: "../evil" })).toThrow(/traversal/);
    expect(() => DependencySpecSchema.parse({ kind: "node-package", id: "/abs/path" })).toThrow(/traversal/);
    expect(() => DependencySpecSchema.parse({ kind: "executable", id: "a/../b" })).toThrow(/traversal/);
    expect(() => DependencySpecSchema.parse({ kind: "node-package", id: "pkg\\evil" })).toThrow();
  });

  it("treats declarations as an optional list", () => {
    expect(parseDependencySpecs(undefined)).toEqual([]);
    expect(parseDependencySpecs(null)).toEqual([]);
    expect(() => parseDependencySpecs([{ kind: "executable", id: "ok" }, { kind: "nope", id: "x" }])).toThrow();
  });

  it("drops the whole list with a warning when any entry is invalid", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(safeParseDependencySpecs([{ kind: "nope", id: "x" }])).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("helpers", () => {
  it("derives the package root from a subpath or versioned spec", () => {
    expect(packageRootOf("@langchain/community/tools/tavily_search")).toBe("@langchain/community");
    expect(packageRootOf("@openai/codex@1.2.3")).toBe("@openai/codex");
    expect(packageRootOf("lodash/fp")).toBe("lodash");
    expect(packageRootOf("lodash@4.17.21")).toBe("lodash");
  });

  it("keys specs by kind, id, scope, version, and bin", () => {
    const a = dependencyKey({ kind: "node-package", id: "pkg" });
    expect(a).toBe(dependencyKey({ kind: "node-package", id: "pkg", scope: "managed" }));
    expect(a).not.toBe(dependencyKey({ kind: "node-package", id: "pkg", scope: "global" }));
    expect(a).not.toBe(dependencyKey({ kind: "executable", id: "pkg" }));
  });

  it("labels dependencies for UI and error text", () => {
    expect(dependencyLabel({ kind: "node-package", id: "@openai/codex", scope: "global", bin: "codex" }))
      .toBe("@openai/codex (codex)");
    expect(dependencyLabel({ kind: "node-package", id: "@langchain/community" })).toBe("@langchain/community");
    expect(dependencyLabel({ kind: "executable", id: "docker" })).toBe("docker");
    expect(dependencyLabel({ kind: "node-runtime", id: "node" })).toBe("Node.js runtime");
  });

  it("treats only an explicit false as optional", () => {
    expect(isRequired({ kind: "executable", id: "x" })).toBe(true);
    expect(isRequired({ kind: "executable", id: "x", required: true })).toBe(true);
    expect(isRequired({ kind: "executable", id: "x", required: false })).toBe(false);
  });
});
