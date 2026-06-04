import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
