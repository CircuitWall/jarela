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
    ".githooks/pre-commit",
  ])("runs the full suite when %s changes", (file) => {
    expect(selectTests(modified("lib/a.ts", file)).mode).toBe("full");
  });

  it("runs the full suite for non-code files tests may read", () => {
    expect(selectTests(modified("lib/skills/foo/SKILL.md")).mode).toBe("full");
    expect(selectTests(modified(".github/workflows/ci.yml")).mode).toBe("full");
    expect(selectTests(modified("lib/integrations/manifest.json")).mode).toBe("full");
  });

  it("runs the full suite when a code file is deleted or renamed", () => {
    expect(selectTests([{ status: "D", path: "lib/a.ts" }]).mode).toBe("full");
    expect(selectTests(parseNameStatus("R090\0lib/a.ts\0lib/b.ts\0")).mode).toBe("full");
  });

  it("normalizes Windows separators", () => {
    expect(selectTests(modified("lib\\a.ts"))).toEqual({ mode: "related", files: ["lib/a.ts"] });
    expect(selectTests(modified("tests\\setup-rtl.ts")).mode).toBe("full");
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

  it("falls back to the full suite for very large changes", () => {
    const many = modified(...Array.from({ length: 101 }, (_, i) => `lib/f${i}.ts`));
    expect(selectTests(many).mode).toBe("full");
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
