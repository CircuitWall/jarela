import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isReleaseMetadataOnly } from "./ci-release-metadata.mjs";

const generated = [
  "CHANGELOG.md", "package.json", "package-lock.json",
  "docs/adoption/changesets.json", "docs/adoption/index.md",
  "docs/adoption/surface-snapshot.json",
];
const manifest = { name: "fixture", version: "1.0.0", dependencies: { example: "1.0.0" } };
const lock = { ...manifest, lockfileVersion: 3, packages: {
  "": { ...manifest },
  "node_modules/example": { version: "1.0.0", integrity: "fixture" },
} };

function readJson(revision, file) {
  const json = structuredClone(file === "package.json" ? manifest : lock);
  if (revision === "head") {
    json.version = "1.0.1";
    if (json.packages) json.packages[""].version = "1.0.1";
  }
  return json;
}

describe("release metadata CI classification", () => {
  it("recognizes all generated release files, including adoption metadata", () => {
    expect(isReleaseMetadataOnly(generated, readJson)).toBe(true);
  });

  it.each(["lib/runtime.ts", "scripts/release.mjs", ".github/workflows/ci.yml", "docs/adoption/other.json"])(
    "does not skip validation for an additional changed file: %s", (file) => {
      expect(isReleaseMetadataOnly([...generated, file], readJson)).toBe(false);
    },
  );

  it.each(["package.json", "package-lock.json"])("rejects dependency changes in %s", (changedFile) => {
    expect(isReleaseMetadataOnly(generated, (revision, file) => {
      const json = readJson(revision, file);
      if (revision === "head" && file === changedFile) json.dependencies.example = "2.0.0";
      return json;
    })).toBe(false);
  });

  it("rejects transitive dependency version changes, even with a version-only diff", () => {
    expect(isReleaseMetadataOnly(generated, (revision, file) => {
      const json = readJson(revision, file);
      if (revision === "head" && file === "package-lock.json") {
        json.packages["node_modules/example"].version = "2.0.0";
      }
      return json;
    })).toBe(false);
  });

  it("rejects empty changes and propagates invalid manifest errors", () => {
    expect(isReleaseMetadataOnly([], readJson)).toBe(false);
    expect(() => isReleaseMetadataOnly(generated, () => JSON.parse("{"))).toThrow();
  });

  it("runs expensive jobs only on dispatch for metadata, but on PRs for runtime changes", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(workflow).toContain('node scripts/ci-release-metadata.mjs "$range"');
    for (const job of ["build", "unit-coverage", "e2e"]) {
      const section = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [\w-]+:\n/)[0];
      const condition = section.split("\n").find((line) => line.trimStart().startsWith("if:"));
      expect(condition).toContain("github.event_name == 'workflow_dispatch' && inputs.release_validation");
      expect(condition).toContain("github.event_name == 'pull_request' && needs.changes.outputs.app == 'true' && needs.changes.outputs.release_meta_only != 'true'");
    }
  });
});
