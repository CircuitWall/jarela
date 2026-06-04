import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Pin HOME to a tmpdir so the workspace_init sensitive-roots check has a
// known reference point and the tools don't touch the developer's home.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-workspace-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
delete process.env.JARELA_ALLOW_SENSITIVE_FILES;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { workspaceInitTool, workspaceStatusTool, workspaceCloseTool } = await import("./workspace");
const { fileReadTool, fileWriteTool } = await import("./files");
const { _resetWorkspaceContext, currentWorkspace } = await import("./workspace-context");

let projectRoot: string;
beforeEach(() => {
  _resetWorkspaceContext();
  projectRoot = mkdtempSync(join(tmpRoot, "proj-"));
  mkdirSync(process.env.JARELA_DB_DIR!, { recursive: true });
});

function parse(s: string) { return JSON.parse(s) as Record<string, unknown>; }

describe("workspace_init", () => {
  it("registers the workspace and returns a context bundle", async () => {
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({
      name: "demo",
      scripts: { test: "vitest", build: "tsc" },
      devDependencies: { vitest: "^1", next: "^15", react: "^19" },
    }));
    writeFileSync(join(projectRoot, "README.md"), "# Demo\n\nA test project.");
    writeFileSync(join(projectRoot, "src.ts"), "export {};");

    const out = parse(await workspaceInitTool.invoke({ path: projectRoot }));
    expect(out.ok).toBe(true);
    expect(out.root).toBe(projectRoot);
    expect(out.scoped).toBe(false);

    const project = out.project as Record<string, unknown>;
    expect(project.test_runner).toBe("vitest");
    expect(project.scripts).toMatchObject({ test: "vitest", build: "tsc" });
    expect(project.framework_hints).toEqual(expect.arrayContaining(["next", "react"]));
    expect(project.languages).toEqual(expect.arrayContaining(["typescript"]));

    const readme = out.readme as Record<string, unknown>;
    expect(readme.path).toBe("README.md");
    expect(String(readme.head)).toContain("Demo");

    // Workspace was installed in the default slot.
    expect(currentWorkspace()?.root).toBe(projectRoot);
  });

  it("refuses sensitive roots without override", async () => {
    const ssh = join(tmpRoot, ".ssh");
    mkdirSync(ssh, { recursive: true });
    const out = parse(await workspaceInitTool.invoke({ path: ssh }));
    expect(out.ok).toBe(false);
    expect(out.code).toBe("WORKSPACE_SENSITIVE");
    expect(currentWorkspace()).toBeUndefined();
  });

  it("refuses non-existent paths", async () => {
    const out = parse(await workspaceInitTool.invoke({ path: join(projectRoot, "does-not-exist") }));
    expect(out.ok).toBe(false);
    expect(out.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("refuses files (path must be a directory)", async () => {
    const f = join(projectRoot, "file.txt");
    writeFileSync(f, "hello");
    const out = parse(await workspaceInitTool.invoke({ path: f }));
    expect(out.ok).toBe(false);
    expect(out.code).toBe("WORKSPACE_NOT_DIR");
  });

  it("detects pnpm via lockfile", async () => {
    writeFileSync(join(projectRoot, "pnpm-lock.yaml"), "");
    const out = parse(await workspaceInitTool.invoke({ path: projectRoot, include_git: false }));
    expect((out.project as Record<string, unknown>).package_manager).toBe("pnpm");
  });

  it("surfaces CLAUDE.md / CONTRIBUTING.md / ADR dir", async () => {
    writeFileSync(join(projectRoot, "CLAUDE.md"), "# Claude\n");
    writeFileSync(join(projectRoot, "CONTRIBUTING.md"), "# Contributing\n");
    mkdirSync(join(projectRoot, "docs", "adr"), { recursive: true });
    const out = parse(await workspaceInitTool.invoke({ path: projectRoot, include_git: false }));
    const conv = out.conventions as Record<string, unknown>;
    expect(conv.claude_md).toBe("CLAUDE.md");
    expect(conv.contributing_md).toBe("CONTRIBUTING.md");
    expect(conv.adr_dir).toBe("docs/adr");
  });

  it("walks a bounded directory tree honouring the default ignore list", async () => {
    mkdirSync(join(projectRoot, "src"));
    writeFileSync(join(projectRoot, "src", "a.ts"), "");
    mkdirSync(join(projectRoot, "node_modules"));
    writeFileSync(join(projectRoot, "node_modules", "ignored.txt"), "");
    const out = parse(await workspaceInitTool.invoke({ path: projectRoot, include_git: false }));
    const tree = out.tree as { entries: Array<{ path: string }> };
    const paths = tree.entries.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["src/", "src/a.ts"]));
    expect(paths.find((p) => p.includes("node_modules"))).toBeUndefined();
  });
});

describe("workspace + file tools", () => {
  it("file_write with a relative path lands inside the workspace root", async () => {
    await workspaceInitTool.invoke({ path: projectRoot, include_tree: false, include_git: false });
    const out = parse(await fileWriteTool.invoke({ path: "notes.md", content: "hi" }));
    expect(out.ok).toBe(true);
    expect(out.path).toBe(join(projectRoot, "notes.md"));
    expect(readFileSync(join(projectRoot, "notes.md"), "utf8")).toBe("hi");
  });

  it("absolute paths are still honoured even with a workspace open", async () => {
    await workspaceInitTool.invoke({ path: projectRoot, include_tree: false, include_git: false });
    const target = join(tmpRoot, "outside.txt");
    const out = parse(await fileWriteTool.invoke({ path: target, content: "ok" }));
    expect(out.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it("scoped=true refuses absolute paths outside the workspace", async () => {
    await workspaceInitTool.invoke({ path: projectRoot, scoped: true, include_tree: false, include_git: false });
    const out = parse(await fileWriteTool.invoke({ path: join(tmpRoot, "outside.txt"), content: "no" }));
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/outside the scoped workspace/);
  });

  it("scoped=true still allows reads/writes inside the workspace", async () => {
    await workspaceInitTool.invoke({ path: projectRoot, scoped: true, include_tree: false, include_git: false });
    const out = parse(await fileWriteTool.invoke({ path: "inside.txt", content: "ok" }));
    expect(out.ok).toBe(true);
    const read = parse(await fileReadTool.invoke({ path: "inside.txt" }));
    expect(read.ok).toBe(true);
    expect(read.content).toBe("ok");
  });
});

describe("workspace_status / workspace_close", () => {
  it("status returns active=false when nothing is open", async () => {
    const out = parse(await workspaceStatusTool.invoke({}));
    expect(out.ok).toBe(true);
    expect(out.active).toBe(false);
  });

  it("status returns the active workspace after init", async () => {
    await workspaceInitTool.invoke({ path: projectRoot, include_tree: false, include_git: false });
    const out = parse(await workspaceStatusTool.invoke({}));
    expect(out.active).toBe(true);
    expect(out.root).toBe(projectRoot);
  });

  it("close clears the workspace and falls back to $HOME for relative paths", async () => {
    await workspaceInitTool.invoke({ path: projectRoot, include_tree: false, include_git: false });
    const closed = parse(await workspaceCloseTool.invoke({}));
    expect(closed.ok).toBe(true);
    expect(closed.was_active).toBe(true);

    const out = parse(await fileWriteTool.invoke({ path: "after-close.txt", content: "z" }));
    expect(out.ok).toBe(true);
    expect(out.path).toBe(join(tmpRoot, "after-close.txt"));
  });

  it("close on an inactive workspace reports was_active=false", async () => {
    const out = parse(await workspaceCloseTool.invoke({}));
    expect(out.ok).toBe(true);
    expect(out.was_active).toBe(false);
  });
});

// Detect whether git is on PATH. The git-probe tests are skipped in CI
// environments without git rather than failing.
function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(hasGit())("workspace_init — git probe", () => {
  function gitInit(dir: string): void {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@e.st"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
  }

  it("reports is_repo=true with branch/head/remote/dirty for a real repo", async () => {
    gitInit(projectRoot);
    writeFileSync(join(projectRoot, "a.txt"), "hello");
    execFileSync("git", ["add", "."], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://example.com/x.git"], { cwd: projectRoot, stdio: "ignore" });

    // Dirty + untracked
    writeFileSync(join(projectRoot, "a.txt"), "modified");
    writeFileSync(join(projectRoot, "new.txt"), "fresh");

    const out = parse(await workspaceInitTool.invoke({ path: projectRoot, include_tree: false }));
    expect(out.ok).toBe(true);
    const git = out.git as Record<string, unknown>;
    expect(git.is_repo).toBe(true);
    expect(git.branch).toBe("main");
    expect(typeof git.head).toBe("string");
    expect((git.head as string).length).toBeGreaterThan(0);
    expect(git.remote).toBe("https://example.com/x.git");
    expect(git.dirty).toBe(true);
    expect(git.untracked_count).toBe(1);
  });

  it("reports is_repo=false for a non-git directory", async () => {
    const out = parse(await workspaceInitTool.invoke({ path: projectRoot, include_tree: false }));
    expect((out.git as Record<string, unknown>).is_repo).toBe(false);
  });

  it("workspace_status re-probes git and reflects fresh state", async () => {
    gitInit(projectRoot);
    writeFileSync(join(projectRoot, "x.txt"), "v1");
    execFileSync("git", ["add", "."], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "v1"], { cwd: projectRoot, stdio: "ignore" });

    await workspaceInitTool.invoke({ path: projectRoot, include_tree: false });
    // Mutate the tree AFTER init — status should pick it up.
    writeFileSync(join(projectRoot, "untracked.txt"), "");
    const out = parse(await workspaceStatusTool.invoke({}));
    expect(out.active).toBe(true);
    const git = out.git as Record<string, unknown>;
    expect(git.is_repo).toBe(true);
    expect(git.untracked_count).toBe(1);
  });
});

describe("workspace_init — probe opt-outs and edge cases", () => {
  it("rejects empty path with WORKSPACE_BAD_PATH", async () => {
    const out = parse(await workspaceInitTool.invoke({ path: "   " }));
    expect(out.ok).toBe(false);
    expect(out.code).toBe("WORKSPACE_BAD_PATH");
  });

  it("expands ~/foo to a path under $HOME", async () => {
    const sub = "ws-tilde";
    mkdirSync(join(tmpRoot, sub));
    const out = parse(await workspaceInitTool.invoke({ path: `~/${sub}`, include_tree: false, include_git: false }));
    expect(out.ok).toBe(true);
    expect(out.root).toBe(join(tmpRoot, sub));
  });

  it("JARELA_ALLOW_SENSITIVE_FILES=1 bypasses the sensitive-root denylist", async () => {
    const ssh = join(tmpRoot, ".ssh");
    mkdirSync(ssh, { recursive: true });
    process.env.JARELA_ALLOW_SENSITIVE_FILES = "1";
    try {
      const out = parse(await workspaceInitTool.invoke({ path: ssh, include_tree: false, include_git: false }));
      expect(out.ok).toBe(true);
      expect(out.root).toBe(ssh);
    } finally {
      delete process.env.JARELA_ALLOW_SENSITIVE_FILES;
    }
  });

  it("respects include_tree=false / include_readme=false / include_scripts=false / include_git=false", async () => {
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    writeFileSync(join(projectRoot, "README.md"), "# hi");
    const out = parse(await workspaceInitTool.invoke({
      path: projectRoot,
      include_tree: false,
      include_readme: false,
      include_scripts: false,
      include_git: false,
    }));
    expect(out.ok).toBe(true);
    expect(out.tree).toBeUndefined();
    expect(out.readme).toBeNull();
    const project = out.project as Record<string, unknown>;
    expect(project.scripts).toEqual({});
    expect(project.package_manager).toBe("none");
    expect(project.makefile_targets).toEqual([]);
    expect((out.git as Record<string, unknown>).is_repo).toBe(false);
  });

  it("parses Makefile targets, ignoring recipes and variable assignments, dedupes, and caps at 50", async () => {
    const lines: string[] = [
      "VAR := value",
      "build: deps",
      "\t@echo recipe-line-should-not-be-parsed:",
      "test:",
      "\techo running",
      "build: more-deps", // duplicate
      ".PHONY: clean",
      "clean:",
      "\trm -rf out",
    ];
    // Add 60 generated targets to exercise the 50-cap.
    for (let i = 0; i < 60; i++) lines.push(`gen${i}:`);
    writeFileSync(join(projectRoot, "Makefile"), lines.join("\n"));

    const out = parse(await workspaceInitTool.invoke({ path: projectRoot, include_tree: false, include_git: false }));
    const targets = (out.project as Record<string, unknown>).makefile_targets as string[];
    expect(targets.length).toBe(50);
    expect(targets).toContain("build");
    expect(targets).toContain("test");
    expect(targets).toContain("clean");
    expect(targets).toContain(".PHONY");
    expect(targets.filter((t) => t === "build").length).toBe(1); // deduped
    expect(targets).not.toContain("recipe-line-should-not-be-parsed");
  });

  it("max_tree_entries truncates the tree and sets truncated=true", async () => {
    mkdirSync(join(projectRoot, "src"));
    for (let i = 0; i < 20; i++) writeFileSync(join(projectRoot, "src", `f${i}.ts`), "");
    const out = parse(await workspaceInitTool.invoke({
      path: projectRoot,
      include_git: false,
      max_tree_entries: 5,
    }));
    const tree = out.tree as { entries: unknown[]; truncated: boolean };
    expect(tree.entries.length).toBe(5);
    expect(tree.truncated).toBe(true);
  });

  it("detects test_runner='npm:test' when scripts.test exists without a known runner dep", async () => {
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({
      scripts: { test: "echo nothing" },
      dependencies: {},
    }));
    const out = parse(await workspaceInitTool.invoke({ path: projectRoot, include_tree: false, include_git: false }));
    expect((out.project as Record<string, unknown>).test_runner).toBe("npm:test");
  });

  it("detects rust + cargo via Cargo.toml", async () => {
    writeFileSync(join(projectRoot, "Cargo.toml"), '[package]\nname = "x"\n');
    writeFileSync(join(projectRoot, "main.rs"), "fn main() {}");
    const out = parse(await workspaceInitTool.invoke({ path: projectRoot, include_tree: false, include_git: false }));
    const project = out.project as Record<string, unknown>;
    expect(project.languages).toContain("rust");
    expect(project.package_manager).toBe("cargo");
  });

  it("detects Dockerfile and devcontainer presence", async () => {
    writeFileSync(join(projectRoot, "Dockerfile"), "FROM scratch\n");
    mkdirSync(join(projectRoot, ".devcontainer"));
    writeFileSync(join(projectRoot, ".devcontainer", "devcontainer.json"), "{}");
    const out = parse(await workspaceInitTool.invoke({ path: projectRoot, include_tree: false, include_git: false }));
    const project = out.project as Record<string, unknown>;
    expect(project.has_dockerfile).toBe(true);
    expect(project.has_devcontainer).toBe(true);
  });

  it("workspace state is keyed by thread_id and isolated between threads", async () => {
    const second = mkdtempSync(join(tmpRoot, "proj-second-"));
    await workspaceInitTool.invoke(
      { path: projectRoot, include_tree: false, include_git: false },
      { configurable: { thread_id: "t-A" } },
    );
    await workspaceInitTool.invoke(
      { path: second, include_tree: false, include_git: false },
      { configurable: { thread_id: "t-B" } },
    );

    expect(currentWorkspace({ configurable: { thread_id: "t-A" } })?.root).toBe(projectRoot);
    expect(currentWorkspace({ configurable: { thread_id: "t-B" } })?.root).toBe(second);

    // File tools resolve relative paths per-thread.
    const a = parse(await fileWriteTool.invoke(
      { path: "ours.txt", content: "A" },
      { configurable: { thread_id: "t-A" } },
    ));
    const b = parse(await fileWriteTool.invoke(
      { path: "ours.txt", content: "B" },
      { configurable: { thread_id: "t-B" } },
    ));
    expect(a.path).toBe(join(projectRoot, "ours.txt"));
    expect(b.path).toBe(join(second, "ours.txt"));
    expect(readFileSync(a.path as string, "utf8")).toBe("A");
    expect(readFileSync(b.path as string, "utf8")).toBe("B");
  });
});
