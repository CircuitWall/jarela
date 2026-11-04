import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import url from "node:url";
import { parseNameStatus, selectTests } from "./select-precommit-tests.mjs";

const SCRIPT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "select-precommit-tests.mjs");

const modified = (...paths) => paths.map((p) => ({ status: "M", path: p }));

describe("parseNameStatus", () => {
  it("parses NUL-separated name-status output, splitting renames into delete + add", () => {
    const raw = ["M", "lib/a.ts", "R100", "lib/old.ts", "lib/new.ts", "D", "lib/gone.ts", ""].join("\0");
    expect(parseNameStatus(raw)).toEqual([
      { status: "M", path: "lib/a.ts" },
      { status: "D", path: "lib/old.ts" },
      { status: "A", path: "lib/new.ts" },
      { status: "D", path: "lib/gone.ts" },
    ]);
  });

  it("keeps paths with spaces and newlines intact", () => {
    expect(parseNameStatus("A\0lib/odd name\nfile.ts\0")).toEqual([{ status: "A", path: "lib/odd name\nfile.ts" }]);
  });

  it("returns nothing for empty input and ignores a truncated trailing entry", () => {
    expect(parseNameStatus("")).toEqual([]);
    expect(parseNameStatus("M\0")).toEqual([]);
  });
});

describe("selectTests", () => {
  it("selects only directly paired unit tests for changed code", () => {
    const siblings = new Set([
      "lib/tools/foo.test.ts",
      "components/Bar.test.tsx",
      "scripts/x.test.mjs",
    ]);
    expect(selectTests(modified("lib/tools/foo.ts", "components/Bar.tsx", "scripts/x.mjs"), {
      exists: (file) => siblings.has(file),
    })).toEqual({
      mode: "unit",
      files: ["lib/tools/foo.test.ts", "components/Bar.test.tsx", "scripts/x.test.mjs"],
    });
  });

  it("skips tests for docs-only commits", () => {
    expect(selectTests(modified("README.md", "docs/ARCHITECTURE.md", ".github/pull_request_template.md"))).toEqual({
      mode: "none",
      files: [],
    });
  });

  it("ignores docs alongside code while selecting a direct sibling test", () => {
    expect(selectTests(modified("docs/x.md", "lib/a.ts"), {
      exists: (file) => file === "lib/a.test.ts",
    })).toEqual({ mode: "unit", files: ["lib/a.test.ts"] });
  });

  it.each([
    "vitest.config.mts",
    "tests/setup-rtl.ts",
    "package.json",
    "package-lock.json",
    "packages/foo/package.json",
    "tsconfig.json",
    ".npmrc",
  ])("leaves broad %s validation to CI without escalating local code tests", (file) => {
    expect(selectTests(modified("lib/a.ts", file), {
      exists: (candidate) => candidate === "lib/a.test.ts",
    })).toEqual({ mode: "unit", files: ["lib/a.test.ts"] });
    expect(selectTests(modified(file))).toEqual({ mode: "none", files: [] });
  });

  it("leaves non-code fixture and configuration coverage to CI when no focused test exists", () => {
    for (const file of ["lib/skills/foo/SKILL.md", ".github/workflows/ci.yml", "lib/integrations/manifest.json"]) {
      expect(selectTests(modified(file), { exists: () => false })).toEqual({ mode: "none", files: [] });
    }
  });

  it("leaves deleted-module coverage to CI and selects a direct test of renamed code", () => {
    expect(selectTests([{ status: "D", path: "lib/a.ts" }])).toEqual({ mode: "none", files: [] });
    expect(selectTests(parseNameStatus("R090\0lib/a.ts\0lib/b.ts\0"), {
      exists: (file) => file === "lib/b.test.ts",
    })).toEqual({ mode: "unit", files: ["lib/b.test.ts"] });
  });

  it("normalizes Windows separators", () => {
    expect(selectTests(modified("lib\\a.ts"), {
      exists: (file) => file === "lib/a.test.ts",
    })).toEqual({ mode: "unit", files: ["lib/a.test.ts"] });
    expect(selectTests(modified("tests\\setup-rtl.ts")).mode).toBe("none");
  });

  it("selects only direct sibling tests, including subprocess-tested scripts", () => {
    const exists = (p) => p === "scripts/jarela-bin.test.mjs" || p === "lib/a.test.ts";
    expect(selectTests(modified("scripts/jarela-bin.mjs", "lib/a.ts", "lib/b.ts"), { exists })).toEqual({
      mode: "unit",
      files: ["scripts/jarela-bin.test.mjs", "lib/a.test.ts"],
    });
  });

  it("runs staged tests directly and does not add a test of the test file", () => {
    const exists = (p) => p === "lib/a.test.ts" || p.startsWith("lib/a.test.test");
    expect(selectTests(modified("lib/a.ts", "lib/a.test.ts"), { exists })).toEqual({
      mode: "unit",
      files: ["lib/a.test.ts"],
    });
  });

  it("keeps only available sibling unit tests for very large changes", () => {
    const many = modified(...Array.from({ length: 101 }, (_, i) => `lib/f${i}.ts`));
    const result = selectTests(many, { exists: (file) => file === "lib/f50.test.ts" });
    expect(result).toEqual({ mode: "unit", files: ["lib/f50.test.ts"] });
  });

  it("selects selector coverage for hook changes", () => {
    expect(selectTests(modified(".githooks/pre-commit"), {
      exists: (file) => file === "scripts/select-precommit-tests.test.mjs",
    })).toEqual({
      mode: "unit",
      files: ["scripts/select-precommit-tests.test.mjs"],
    });
  });

  it("selects existing sibling tests of data files without adding non-code import targets", () => {
    expect(selectTests(modified("lib/example.json"), {
      exists: (file) => file === "lib/example.test.ts",
    })).toEqual({ mode: "unit", files: ["lib/example.test.ts"] });
  });

  it("runs only explicitly staged tests alongside shared setup and deleted files", () => {
    expect(selectTests([
      ...modified("tests/setup-rtl.ts", "lib/a.test.ts", "package.json"),
      { status: "D", path: "lib/old.ts" },
    ])).toEqual({ mode: "unit", files: ["lib/a.test.ts"] });
  });
});

describe("CLI", () => {
  function run(input, env = {}) {
    const result = spawnSync(process.execPath, [SCRIPT], { input, encoding: "utf8", env: { ...process.env, ...env } });
    expect(result.status).toBe(0);
    return result.stdout.split("\0").slice(0, -1);
  }

  it("prints the mode and files as NUL-separated tokens", () => {
    expect(run("M\0README.md\0")).toEqual(["none"]);
  });

  it("includes the existing sibling test of a staged script", () => {
    expect(run("M\0scripts/select-precommit-tests.mjs\0")).toEqual([
      "unit",
      "scripts/select-precommit-tests.test.mjs",
    ]);
  });

  it("prints none for empty input", () => {
    expect(run("")).toEqual(["none"]);
  });
});
