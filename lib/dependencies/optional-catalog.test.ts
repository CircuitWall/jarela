import { describe, expect, it } from "vitest";
import {
  OPTIONAL_PACKAGES,
  OPTIONAL_PACKAGE_CATEGORIES,
  OPTIONAL_PACKAGE_CATEGORY_LABELS,
  findOptionalPackage,
  listOptionalPackages,
  optionalPackageTarget,
} from "./optional-catalog";

describe("optional package catalogue", () => {
  it("labels every category", () => {
    for (const category of OPTIONAL_PACKAGE_CATEGORIES) {
      expect(OPTIONAL_PACKAGE_CATEGORY_LABELS[category]?.length).toBeGreaterThan(0);
    }
  });

  it("describes every entry in terms a user can decide on", () => {
    for (const entry of OPTIONAL_PACKAGES) {
      expect(entry.id).toMatch(/^@?[A-Za-z0-9._~/-]+$/);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(10);
      expect(entry.withoutIt.length).toBeGreaterThan(10);
      expect(entry.sizeMb).toBeGreaterThan(0);
      expect(entry.spec).toMatchObject({ kind: "node-package", id: entry.id, scope: "managed" });
    }
  });

  it("keeps the two heavy runtimes on demand", () => {
    expect(OPTIONAL_PACKAGES.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["@huggingface/transformers", "@microsoft/copilot-sdk"]),
    );
  });

  it("looks entries up by package id and builds the install target", () => {
    expect(findOptionalPackage("@microsoft/copilot-sdk")?.category).toBe("agent-runtimes");
    expect(findOptionalPackage("not-a-package")).toBeNull();
    expect(optionalPackageTarget("@microsoft/copilot-sdk")).toBe("runtime:@microsoft/copilot-sdk");
  });

  it("filters by category", () => {
    expect(listOptionalPackages("embeddings").map((entry) => entry.id)).toEqual(["@huggingface/transformers"]);
    expect(listOptionalPackages().length).toBe(OPTIONAL_PACKAGES.length);
  });
});
