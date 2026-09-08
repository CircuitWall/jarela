import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { probeGit, gitDiffSummary } from "./git-probe";

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", env: cleanGitEnv() });
    return true;
  } catch {
    return false;
  }
}

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "jarela-test-git-probe-"));
});

function gitInit(dir: string): void {
  const env = cleanGitEnv();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore", env });
  execFileSync("git", ["config", "user.email", "t@e.st"], { cwd: dir, stdio: "ignore", env });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore", env });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore", env });
}

function commitAll(dir: string, message: string): void {
  const env = cleanGitEnv();
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore", env });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, stdio: "ignore", env });
}

describe.runIf(hasGit())("probeGit", () => {
  it("reports is_repo=false for a non-git directory", async () => {
    expect(await probeGit(projectRoot)).toEqual({ is_repo: false });
  });

  it("reports branch/head/remote/dirty for a real repo", async () => {
    gitInit(projectRoot);
    writeFileSync(join(projectRoot, "a.txt"), "hello");
    commitAll(projectRoot, "init");
    execFileSync("git", ["remote", "add", "origin", "https://example.com/x.git"], { cwd: projectRoot, stdio: "ignore", env: cleanGitEnv() });
    writeFileSync(join(projectRoot, "new.txt"), "fresh");

    const out = await probeGit(projectRoot);
    expect(out.is_repo).toBe(true);
    expect(out.branch).toBe("main");
    expect(out.remote).toBe("https://example.com/x.git");
    expect(out.dirty).toBe(true);
    expect(out.untracked_count).toBe(1);
  });
});

describe.runIf(hasGit())("gitDiffSummary", () => {
  it("returns is_repo=false for a non-git directory", async () => {
    expect(await gitDiffSummary(projectRoot)).toEqual({
      is_repo: false, dirty: false, files_changed: 0, insertions: 0, deletions: 0, status_lines: [],
    });
  });

  it("reports a clean repo as not dirty with zero changes", async () => {
    gitInit(projectRoot);
    writeFileSync(join(projectRoot, "a.txt"), "hello\n");
    commitAll(projectRoot, "init");

    const out = await gitDiffSummary(projectRoot);
    expect(out.is_repo).toBe(true);
    expect(out.dirty).toBe(false);
    expect(out.files_changed).toBe(0);
    expect(out.status_lines).toEqual([]);
  });

  it("reports insertions/deletions for a tracked-file edit", async () => {
    gitInit(projectRoot);
    writeFileSync(join(projectRoot, "a.txt"), "line1\nline2\nline3\n");
    commitAll(projectRoot, "init");

    writeFileSync(join(projectRoot, "a.txt"), "line1\nCHANGED\nline3\nline4\n");

    const out = await gitDiffSummary(projectRoot);
    expect(out.is_repo).toBe(true);
    expect(out.dirty).toBe(true);
    expect(out.files_changed).toBe(1);
    expect(out.insertions).toBeGreaterThan(0);
    expect(out.deletions).toBeGreaterThan(0);
    expect(out.status_lines).toEqual([" M a.txt"]);
  });

  it("surfaces untracked new files in status_lines even though diff --stat can't see them", async () => {
    gitInit(projectRoot);
    writeFileSync(join(projectRoot, "a.txt"), "hello\n");
    commitAll(projectRoot, "init");

    writeFileSync(join(projectRoot, "brand-new.txt"), "created by claude\n");

    const out = await gitDiffSummary(projectRoot);
    expect(out.dirty).toBe(true);
    expect(out.status_lines).toEqual(["?? brand-new.txt"]);
    // diff --stat HEAD only sees tracked changes — untracked files aren't
    // counted in files_changed/insertions, only surfaced via status_lines.
    expect(out.files_changed).toBe(0);
  });
});
