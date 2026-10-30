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
  it("runs related tests when only code files changed", () => {
    expect(selectTests(modified("lib/tools/foo.ts", "components/Bar.tsx", "scripts/x.mjs"))).toEqual({
      mode: "related",
      files: ["lib/tools/foo.ts", "components/Bar.tsx", "scripts/x.mjs"],
    });
  });

  it("skips tests for docs-only commits", () => {
    expect(selectTests(modified("README.md", "docs/ARCHITECTURE.md", ".github/pull_request_template.md"))).toEqual({
      mode: "none",
      files: [],
    });
  });

  it("ignores docs alongside code", () => {
    expect(selectTests(modified("docs/x.md", "lib/a.ts"))).toEqual({ mode: "related", files: ["lib/a.ts"] });
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
    expect(selectTests(modified("lib/a.ts", file))).toEqual({ mode: "related", files: ["lib/a.ts"] });
    expect(selectTests(modified(file))).toEqual({ mode: "none", files: [] });
  });

  it("leaves non-code fixture and configuration coverage to CI when no focused test exists", () => {
    for (const file of ["lib/skills/foo/SKILL.md", ".github/workflows/ci.yml", "lib/integrations/manifest.json"]) {
      expect(selectTests(modified(file), { exists: () => false })).toEqual({ mode: "none", files: [] });
    }
  });

  it("leaves deleted-module coverage to CI and selects the destination of renamed code", () => {
    expect(selectTests([{ status: "D", path: "lib/a.ts" }])).toEqual({ mode: "none", files: [] });
    expect(selectTests(parseNameStatus("R090\0lib/a.ts\0lib/b.ts\0")))
      .toEqual({ mode: "related", files: ["lib/b.ts"] });
  });

  it("normalizes Windows separators", () => {
    expect(selectTests(modified("lib\\a.ts"))).toEqual({ mode: "related", files: ["lib/a.ts"] });
    expect(selectTests(modified("tests\\setup-rtl.ts")).mode).toBe("none");
  });

  it("adds sibling test files so subprocess-tested scripts still run their tests", () => {
    const exists = (p) => p === "scripts/jarela-bin.test.mjs" || p === "lib/a.test.ts";
    expect(selectTests(modified("scripts/jarela-bin.mjs", "lib/a.ts", "lib/b.ts"), { exists })).toEqual({
      mode: "related",
      files: ["scripts/jarela-bin.mjs", "scripts/jarela-bin.test.mjs", "lib/a.ts", "lib/a.test.ts", "lib/b.ts"],
    });
  });

  it("does not duplicate a staged sibling test or look for tests of test files", () => {
    const exists = (p) => p === "lib/a.test.ts" || p.startsWith("lib/a.test.test");
    expect(selectTests(modified("lib/a.ts", "lib/a.test.ts"), { exists }).files).toEqual(["lib/a.ts", "lib/a.test.ts"]);
  });

  it("keeps focused selection for very large changes", () => {
    const many = modified(...Array.from({ length: 101 }, (_, i) => `lib/f${i}.ts`));
    const result = selectTests(many);
    expect(result.mode).toBe("related");
    expect(result.files).toHaveLength(101);
  });

  it("selects selector coverage for hook changes", () => {
    expect(selectTests(modified(".githooks/pre-commit"), {
      exists: (file) => file === "scripts/select-precommit-tests.test.mjs",
    })).toEqual({
      mode: "related",
      files: ["scripts/select-precommit-tests.mjs", "scripts/select-precommit-tests.test.mjs"],
    });
  });

  it("selects existing sibling tests of data files without adding non-code import targets", () => {
    expect(selectTests(modified("lib/example.json"), {
      exists: (file) => file === "lib/example.test.ts",
    })).toEqual({ mode: "related", files: ["lib/example.test.ts"] });
  });

  it("retains focused tests when mixed with shared setup and deleted files", () => {
    expect(selectTests([
      ...modified("tests/setup-rtl.ts", "lib/a.test.ts", "package.json"),
      { status: "D", path: "lib/old.ts" },
    ])).toEqual({ mode: "related", files: ["lib/a.test.ts"] });
  });

  it("honors the force-full override", () => {
    expect(selectTests(modified("lib/a.ts"), { forceFull: true })).toEqual({ mode: "full", files: [] });
  });
});

describe("CLI", () => {
  function run(input, env = {}) {
    const result = spawnSync(process.execPath, [SCRIPT], { input, encoding: "utf8", env: { ...process.env, ...env } });
    expect(result.status).toBe(0);
    return result.stdout.split("\0").slice(0, -1);
  }

  it("prints the mode and files as NUL-separated tokens", () => {
    expect(run("M\0lib/a.ts\0A\0lib/b c.ts\0")).toEqual(["related", "lib/a.ts", "lib/b c.ts"]);
  });

  it("includes the existing sibling test of a staged script", () => {
    expect(run("M\0scripts/select-precommit-tests.mjs\0")).toEqual([
      "related",
      "scripts/select-precommit-tests.mjs",
      "scripts/select-precommit-tests.test.mjs",
    ]);
  });

  it("prints none for empty input", () => {
    expect(run("")).toEqual(["none"]);
  });

  it("forces the full suite with JARELA_PRECOMMIT_FULL_TESTS=1", () => {
    expect(run("M\0lib/a.ts\0", { JARELA_PRECOMMIT_FULL_TESTS: "1" })).toEqual(["full"]);
  });
});
