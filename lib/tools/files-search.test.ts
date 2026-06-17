import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin HOME so the credential-file denylist has a known base and our
// fixtures don't touch the developer's real home.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-files-search-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
delete process.env.JARELA_ALLOW_SENSITIVE_FILES;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { fileGlobTool, fileGrepTool, fileMultiEditTool } = await import("./files-search");
const { workspaceInitTool } = await import("./workspace");
const { _resetWorkspaceContext } = await import("./workspace-context");

let projectRoot: string;
beforeEach(() => {
  _resetWorkspaceContext();
  projectRoot = mkdtempSync(join(tmpRoot, "proj-"));
  mkdirSync(process.env.JARELA_DB_DIR!, { recursive: true });
});

function parse(s: string) { return JSON.parse(s) as Record<string, unknown>; }

function seedProject(): void {
  mkdirSync(join(projectRoot, "src", "lib"), { recursive: true });
  mkdirSync(join(projectRoot, "src", "components"), { recursive: true });
  mkdirSync(join(projectRoot, "tests"), { recursive: true });
  mkdirSync(join(projectRoot, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "index.ts"), "export const VERSION = '1.0.0';\n");
  writeFileSync(join(projectRoot, "src", "lib", "util.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
  writeFileSync(join(projectRoot, "src", "components", "Button.tsx"), "export const Button = () => null;\n");
  writeFileSync(join(projectRoot, "tests", "util.test.ts"), "import { add } from '../src/lib/util';\n// TODO: cover overflow\nadd(1, 2);\n");
  writeFileSync(join(projectRoot, "README.md"), "# Demo\n\nTODO: write docs.\n");
  writeFileSync(join(projectRoot, "node_modules", "left-pad", "index.js"), "module.exports = () => 'nope';\n");
}

// ── file_glob ───────────────────────────────────────────────────────────────

describe("file_glob", () => {
  it("matches **/*.ts under the project root and skips node_modules", async () => {
    seedProject();
    const out = parse(await fileGlobTool.invoke({ pattern: "**/*.ts", root: projectRoot }));
    expect(out.ok).toBe(true);
    const matches = out.matches as string[];
    expect(matches).toEqual(expect.arrayContaining([
      "src/index.ts",
      "src/lib/util.ts",
      "tests/util.test.ts",
    ]));
    expect(matches.find((m) => m.includes("node_modules"))).toBeUndefined();
    expect(matches.find((m) => m.endsWith(".tsx"))).toBeUndefined();
  });

  it("supports {a,b} alternation", async () => {
    seedProject();
    const out = parse(await fileGlobTool.invoke({ pattern: "**/*.{ts,tsx}", root: projectRoot }));
    const matches = out.matches as string[];
    expect(matches).toContain("src/components/Button.tsx");
    expect(matches).toContain("src/index.ts");
  });

  it("supports ? single-char and explicit src prefix", async () => {
    seedProject();
    const out = parse(await fileGlobTool.invoke({ pattern: "src/lib/?til.ts", root: projectRoot }));
    expect(out.matches).toEqual(["src/lib/util.ts"]);
  });

  it("defaults root to the active workspace when none is supplied", async () => {
    seedProject();
    await workspaceInitTool.invoke({ path: projectRoot, include_tree: false, include_git: false });
    const out = parse(await fileGlobTool.invoke({ pattern: "**/*.md" }));
    expect(out.matches).toEqual(["README.md"]);
    expect(out.root).toBe(projectRoot);
  });

  it("max_results truncates and sets truncated=true", async () => {
    mkdirSync(join(projectRoot, "many"));
    for (let i = 0; i < 20; i++) writeFileSync(join(projectRoot, "many", `f${i}.ts`), "");
    const out = parse(await fileGlobTool.invoke({ pattern: "**/*.ts", root: projectRoot, max_results: 5 }));
    expect((out.matches as string[]).length).toBe(5);
    expect(out.truncated).toBe(true);
  });

  it("include_hidden=true reveals dot-prefixed paths", async () => {
    mkdirSync(join(projectRoot, ".github"));
    writeFileSync(join(projectRoot, ".github", "ci.yml"), "");
    const hidden = parse(await fileGlobTool.invoke({ pattern: "**/*.yml", root: projectRoot, include_hidden: true }));
    expect(hidden.matches).toEqual([".github/ci.yml"]);
    const noHidden = parse(await fileGlobTool.invoke({ pattern: "**/*.yml", root: projectRoot }));
    expect(noHidden.matches).toEqual([]);
  });

  it("returns ok:false when root is not a directory", async () => {
    const f = join(projectRoot, "file.txt");
    writeFileSync(f, "x");
    const out = parse(await fileGlobTool.invoke({ pattern: "**/*", root: f }));
    expect(out.ok).toBe(false);
  });
});

// ── file_grep ───────────────────────────────────────────────────────────────

describe("file_grep", () => {
  it("finds a regex match with 1-based line numbers", async () => {
    seedProject();
    const out = parse(await fileGrepTool.invoke({ pattern: "TODO", root: projectRoot }));
    expect(out.ok).toBe(true);
    const matches = out.matches as Array<{ path: string; line: number; text: string }>;
    const todoLines = matches.map((m) => `${m.path}:${m.line}`);
    expect(todoLines).toEqual(expect.arrayContaining([
      "tests/util.test.ts:2",
      "README.md:3",
    ]));
  });

  it("literal=true treats regex metachars as plain text", async () => {
    writeFileSync(join(projectRoot, "a.txt"), "foo(bar)\nfoo bar\n");
    const lit = parse(await fileGrepTool.invoke({ pattern: "foo(bar)", literal: true, root: projectRoot }));
    expect((lit.matches as unknown[]).length).toBe(1);
    const re = parse(await fileGrepTool.invoke({ pattern: "foo(bar)", root: projectRoot }));
    // As a regex, `foo(bar)` captures 'foo' then 'bar' adjacent — matches both lines:
    // line 1 "foo(bar)" -> 'foobar' substring? No, regex foo(bar) matches "foobar".
    // line 1 contains "foo(bar)" literal text — regex 'foo(bar)' against that
    // string matches the substring "foobar" if present. It is NOT present; only
    // the literal '(' breaks the match. So the regex matches zero lines here.
    expect((re.matches as unknown[]).length).toBe(0);
  });

  it("case_insensitive=true matches across cases", async () => {
    writeFileSync(join(projectRoot, "x.txt"), "Hello\nhELLO\n");
    const out = parse(await fileGrepTool.invoke({ pattern: "hello", case_insensitive: true, root: projectRoot }));
    expect((out.matches as unknown[]).length).toBe(2);
  });

  it("glob filter restricts which files are scanned", async () => {
    seedProject();
    const out = parse(await fileGrepTool.invoke({
      pattern: "TODO",
      root: projectRoot,
      glob: "**/*.md",
    }));
    const matches = out.matches as Array<{ path: string }>;
    expect(matches.map((m) => m.path)).toEqual(["README.md"]);
  });

  it("returns context lines around each match", async () => {
    writeFileSync(join(projectRoot, "ctx.txt"), "L1\nL2\nMATCH\nL4\nL5\n");
    const out = parse(await fileGrepTool.invoke({
      pattern: "MATCH",
      root: projectRoot,
      context: 1,
    }));
    const m = (out.matches as Array<{ before: string[]; after: string[] }>)[0];
    expect(m.before).toEqual(["L2"]);
    expect(m.after).toEqual(["L4"]);
  });

  it("skips binary files via NUL-byte heuristic", async () => {
    writeFileSync(join(projectRoot, "bin.dat"), Buffer.from([0x42, 0x00, 0x42, 0x43]));
    writeFileSync(join(projectRoot, "text.txt"), "BC\n");
    const out = parse(await fileGrepTool.invoke({ pattern: "BC", root: projectRoot }));
    const paths = (out.matches as Array<{ path: string }>).map((m) => m.path);
    expect(paths).toEqual(["text.txt"]);
  });

  it("returns invalid-pattern error for a bad regex", async () => {
    const out = parse(await fileGrepTool.invoke({ pattern: "[unterminated", root: projectRoot }));
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/invalid pattern/);
  });

  it("max_matches truncates and sets truncated=true", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `hit ${i}`).join("\n");
    writeFileSync(join(projectRoot, "many.txt"), lines);
    const out = parse(await fileGrepTool.invoke({ pattern: "hit", root: projectRoot, max_matches: 5 }));
    expect((out.matches as unknown[]).length).toBe(5);
    expect(out.truncated).toBe(true);
  });

  it("defaults root to the active workspace", async () => {
    seedProject();
    await workspaceInitTool.invoke({ path: projectRoot, include_tree: false, include_git: false });
    const out = parse(await fileGrepTool.invoke({ pattern: "VERSION" }));
    const paths = (out.matches as Array<{ path: string }>).map((m) => m.path);
    expect(paths).toEqual(["src/index.ts"]);
  });

  it("attaches enclosing symbol (function/heading) to each match", async () => {
    writeFileSync(join(projectRoot, "mod.ts"), [
      "export function alpha() {",
      "  return 'TARGET';",  // line 2 → enclosing alpha @ line 1
      "}",
      "export function beta() {",
      "  return 'TARGET';",  // line 5 → enclosing beta @ line 4
      "}",
    ].join("\n"));
    const out = parse(await fileGrepTool.invoke({
      pattern: "TARGET",
      root: projectRoot,
      glob: "mod.ts",
      literal: true,
    }));
    const matches = out.matches as Array<{ line: number; enclosing?: { kind: string; name: string; line: number } }>;
    expect(matches.length).toBe(2);
    expect(matches[0].enclosing).toEqual({ kind: "function", name: "alpha", line: 1 });
    expect(matches[1].enclosing).toEqual({ kind: "function", name: "beta", line: 4 });
  });

  it("attaches enclosing markdown heading to README matches", async () => {
    writeFileSync(join(projectRoot, "doc.md"), [
      "# Top",
      "intro",
      "## Section A",
      "body with NEEDLE here",  // line 4 → ## Section A @ line 3
      "## Section B",
      "another NEEDLE",          // line 6 → ## Section B @ line 5
    ].join("\n"));
    const out = parse(await fileGrepTool.invoke({
      pattern: "NEEDLE", root: projectRoot, glob: "doc.md", literal: true,
    }));
    const matches = out.matches as Array<{ line: number; enclosing?: { name: string; kind: string } }>;
    expect(matches.length).toBe(2);
    expect(matches[0].enclosing).toMatchObject({ kind: "heading", name: "Section A" });
    expect(matches[1].enclosing).toMatchObject({ kind: "heading", name: "Section B" });
  });

  it("omits enclosing when no outline entry precedes the match", async () => {
    writeFileSync(join(projectRoot, "plain.ts"), [
      "// just a comment with NEEDLE",  // line 1, no preceding outline entry
      "export function later() {}",
    ].join("\n"));
    const out = parse(await fileGrepTool.invoke({
      pattern: "NEEDLE", root: projectRoot, glob: "plain.ts", literal: true,
    }));
    const matches = out.matches as Array<{ enclosing?: unknown }>;
    expect(matches[0].enclosing).toBeUndefined();
  });
});

// ── file_multi_edit ─────────────────────────────────────────────────────────

describe("file_multi_edit", () => {
  it("applies multiple anchored edits atomically and reports counts", async () => {
    const f = join(projectRoot, "code.ts");
    writeFileSync(f, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const out = parse(await fileMultiEditTool.invoke({
      path: f,
      edits: [
        { old_string: "const a = 1;", new_string: "const a = 10;" },
        { old_string: "const c = 3;", new_string: "const c = 30;" },
      ],
    }));
    expect(out.ok).toBe(true);
    expect(out.edits_applied).toBe(2);
    expect(readFileSync(f, "utf8")).toBe("const a = 10;\nconst b = 2;\nconst c = 30;\n");
  });

  it("is all-or-nothing: a missing old_string leaves the file untouched", async () => {
    const f = join(projectRoot, "code.ts");
    const original = "const a = 1;\nconst b = 2;\n";
    writeFileSync(f, original);
    const out = parse(await fileMultiEditTool.invoke({
      path: f,
      edits: [
        { old_string: "const a = 1;", new_string: "const a = 10;" },
        { old_string: "DOES NOT EXIST", new_string: "x" },
      ],
    }));
    expect(out.ok).toBe(false);
    expect(readFileSync(f, "utf8")).toBe(original);
    const editStatuses = out.edits as Array<{ index: number; ok: boolean }>;
    expect(editStatuses[0].ok).toBe(true);
    expect(editStatuses[1].ok).toBe(false);
  });

  it("rejects an edit whose old_string matches multiple times", async () => {
    const f = join(projectRoot, "dup.ts");
    writeFileSync(f, "x\nx\n");
    const out = parse(await fileMultiEditTool.invoke({
      path: f,
      edits: [{ old_string: "x", new_string: "y" }],
    }));
    expect(out.ok).toBe(false);
    const editStatuses = out.edits as Array<{ ok: boolean; match_count?: number }>;
    expect(editStatuses[0].match_count).toBe(2);
    expect(readFileSync(f, "utf8")).toBe("x\nx\n");
  });

  it("subsequent edits see earlier edits' results (in-order application)", async () => {
    const f = join(projectRoot, "chain.ts");
    writeFileSync(f, "STEP1\n");
    const out = parse(await fileMultiEditTool.invoke({
      path: f,
      edits: [
        { old_string: "STEP1", new_string: "STEP2" },
        { old_string: "STEP2", new_string: "STEP3" },
      ],
    }));
    expect(out.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("STEP3\n");
  });

  it("supports deletion via empty new_string", async () => {
    const f = join(projectRoot, "del.ts");
    writeFileSync(f, "keep\nremove me\nkeep\n");
    const out = parse(await fileMultiEditTool.invoke({
      path: f,
      edits: [{ old_string: "remove me\n", new_string: "" }],
    }));
    expect(out.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("keep\nkeep\n");
  });

  it("resolves relative paths against the active workspace", async () => {
    const f = join(projectRoot, "ws.ts");
    writeFileSync(f, "ALPHA\n");
    await workspaceInitTool.invoke({ path: projectRoot, include_tree: false, include_git: false });
    const out = parse(await fileMultiEditTool.invoke({
      path: "ws.ts",
      edits: [{ old_string: "ALPHA", new_string: "BETA" }],
    }));
    expect(out.ok).toBe(true);
    expect(out.path).toBe(f);
    expect(readFileSync(f, "utf8")).toBe("BETA\n");
  });
});
