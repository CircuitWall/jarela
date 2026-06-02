import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin HOME to a tmpdir before importing, matching files.test.ts. The tool
// resolves bare relative paths under HOME and applies the credential
// denylist relative to HOME.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-wsctx-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
delete process.env.JARELA_ALLOW_SENSITIVE_FILES;
delete process.env.JARELA_TOOL_SAFETY;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { workspaceContextTool } = await import("./workspace-context");

function parse(s: string) { return JSON.parse(s) as Record<string, unknown>; }

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpRoot, "repo-"));
  mkdirSync(process.env.JARELA_DB_DIR!, { recursive: true });
});

function seedSimpleRepo() {
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "demo-pkg",
    version: "0.1.0",
    scripts: { build: "tsc", test: "vitest" },
    dependencies: { "left-pad": "1.0.0", react: "19.0.0" },
    devDependencies: { typescript: "5.0.0" },
  }, null, 2));
  writeFileSync(join(repo, "README.md"), "# Demo\n\nA sample project for tests.\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "index.ts"), "export const banana = 42;\nexport const orange = 7;\n");
  writeFileSync(join(repo, "src", "util.ts"), "export function tangerine() { return 'fruit'; }\n");
  mkdirSync(join(repo, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "junk", "should-be-ignored.js"), "banana banana banana\n");
}

describe("workspace_context", () => {
  it("returns all sections by default", async () => {
    seedSimpleRepo();
    const out = parse(await workspaceContextTool.invoke({ cwd: repo, query: "banana" }));
    expect(out.ok).toBe(true);
    expect(out.root).toBe(repo);
    const sections = out.sections_included as string[];
    expect(sections.sort()).toEqual(["git", "hits", "package", "readme", "tree"]);
    expect(out.tree).toBeDefined();
    expect(out.package).toBeDefined();
    expect(out.readme).toMatch(/^# Demo/);
  });

  it("respects the include allowlist", async () => {
    seedSimpleRepo();
    const out = parse(await workspaceContextTool.invoke({
      cwd: repo, include: ["package", "readme"],
    }));
    expect(out.tree).toBeUndefined();
    expect(out.git).toBeUndefined();
    expect(out.package).toBeDefined();
    expect(out.readme).toBeDefined();
  });

  it("omits node_modules from the tree", async () => {
    seedSimpleRepo();
    const out = parse(await workspaceContextTool.invoke({ cwd: repo, include: ["tree"] }));
    const json = JSON.stringify(out.tree);
    expect(json).not.toContain("node_modules");
    expect(json).toContain("src");
  });

  it("greps query tokens across files and skips ignored dirs", async () => {
    seedSimpleRepo();
    const out = parse(await workspaceContextTool.invoke({ cwd: repo, query: "banana", include: ["hits"] }));
    const hits = out.hits as Array<{ file: string; line: number; text: string }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => !h.file.includes("node_modules"))).toBe(true);
    expect(hits.some((h) => h.file === "src/index.ts")).toBe(true);
  });

  it("returns is_repo:false outside a git repo", async () => {
    seedSimpleRepo();
    const out = parse(await workspaceContextTool.invoke({ cwd: repo, include: ["git"] }));
    const git = out.git as { is_repo: boolean };
    expect(git.is_repo).toBe(false);
  });

  it("returns git status + branch inside a real repo", async () => {
    seedSimpleRepo();
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, stdio: "ignore" });
    } catch {
      // git not on PATH — skip the assertions
      return;
    }
    writeFileSync(join(repo, "dirty.txt"), "uncommitted");
    const out = parse(await workspaceContextTool.invoke({ cwd: repo, include: ["git"] }));
    const git = out.git as { is_repo: boolean; branch?: string; status?: string[]; recent_commits?: string[] };
    expect(git.is_repo).toBe(true);
    expect(git.branch).toBe("main");
    expect(git.status?.some((l) => l.includes("dirty.txt"))).toBe(true);
    expect(git.recent_commits?.[0]).toMatch(/init/);
  });

  it("refuses cwd inside a credential subtree", async () => {
    const ssh = join(tmpRoot, ".ssh");
    mkdirSync(ssh, { recursive: true });
    writeFileSync(join(ssh, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    const out = parse(await workspaceContextTool.invoke({ cwd: ssh }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/credential directory/);
  });

  it("returns ok:false when cwd doesn't exist", async () => {
    const out = parse(await workspaceContextTool.invoke({ cwd: join(tmpRoot, "nope-does-not-exist") }));
    expect(out.ok).toBe(false);
  });

  it("returns ok:false when cwd is a file, not a directory", async () => {
    const f = join(repo, "afile.txt");
    writeFileSync(f, "x");
    const out = parse(await workspaceContextTool.invoke({ cwd: f }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/must be a directory/);
  });

  it("skips hits section when query is omitted", async () => {
    seedSimpleRepo();
    const out = parse(await workspaceContextTool.invoke({ cwd: repo }));
    expect(out.hits).toBeUndefined();
  });

  it("ignores very short query tokens", async () => {
    seedSimpleRepo();
    const out = parse(await workspaceContextTool.invoke({ cwd: repo, query: "a b c", include: ["hits"] }));
    const hits = out.hits as Array<unknown>;
    expect(hits).toEqual([]);
  });

  it("stays under the byte cap with a large repo", async () => {
    // Generate enough files that the bundle would naturally exceed 24 KB.
    seedSimpleRepo();
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(repo, "src", `f${i}.ts`), `// banana banana banana\nexport const v${i} = ${i};\n`);
    }
    const out = await workspaceContextTool.invoke({ cwd: repo, query: "banana" });
    expect(out.length).toBeLessThanOrEqual(24_000 + 200); // small slack for trim-iteration overshoot
  });

  it("produces relative POSIX paths for hits even on Windows", async () => {
    seedSimpleRepo();
    const out = parse(await workspaceContextTool.invoke({ cwd: repo, query: "banana", include: ["hits"] }));
    const hits = out.hits as Array<{ file: string }>;
    expect(hits.every((h) => !h.file.includes("\\"))).toBe(true);
    expect(hits.every((h) => !h.file.startsWith("/") && !/^[A-Za-z]:/.test(h.file))).toBe(true);
  });
});
