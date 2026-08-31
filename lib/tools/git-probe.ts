// Shared git-shelling helpers. Single source of truth for `workspace_status`
// (repo state probe) and `claude_delegate` (post-run verification diff) so
// there's exactly one place that knows how to ask git a question.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Probe budget. Keep generous enough for slow filesystems but short enough
// that a caller isn't blocked for tens of seconds on a stalled cloud-sync
// provider or a huge repo.
export const GIT_PROBE_TIMEOUT_MS = 8_000;

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

// For single-value output (branch name, short SHA, remote URL) — safe to
// trim on both ends.
async function safeGit(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, { cwd: root, timeout: GIT_PROBE_TIMEOUT_MS, env: cleanGitEnv() });
    return stdout.trim();
  } catch {
    return "";
  }
}

// For multi-line porcelain/stat output, where the first character of each
// line can be a meaningful leading space (e.g. `git status --porcelain`'s
// " M file.txt" for an unstaged modify) — `.trim()` on the whole blob would
// eat that space off line one. Only strip the trailing newline.
async function safeGitRaw(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, { cwd: root, timeout: GIT_PROBE_TIMEOUT_MS, env: cleanGitEnv() });
    return stdout.replace(/\r?\n+$/, "");
  } catch {
    return "";
  }
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    await execFileP("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, timeout: GIT_PROBE_TIMEOUT_MS, env: cleanGitEnv() });
    return true;
  } catch {
    return false;
  }
}

export interface GitProbe {
  is_repo: boolean;
  branch?: string;
  remote?: string;
  head?: string;
  dirty?: boolean;
  untracked_count?: number;
}

// `git rev-parse --is-inside-work-tree` is the canonical "is this a repo?" check.
export async function probeGit(root: string): Promise<GitProbe> {
  if (!(await isGitRepo(root))) return { is_repo: false };

  const out: GitProbe = { is_repo: true };
  const [branch, head, remote, status] = await Promise.all([
    safeGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    safeGit(root, ["rev-parse", "--short", "HEAD"]),
    safeGit(root, ["config", "--get", "remote.origin.url"]),
    safeGitRaw(root, ["status", "--porcelain"]),
  ]);
  if (branch) out.branch = branch;
  if (head) out.head = head;
  if (remote) out.remote = remote;
  const lines = status ? status.split(/\r?\n/) : [];
  out.dirty = lines.length > 0;
  out.untracked_count = lines.filter((l) => l.startsWith("??")).length;
  return out;
}

export interface GitDiffSummary {
  is_repo: boolean;
  dirty: boolean;
  /** Tracked files with a committed-vs-working-tree diff (from `git diff --stat`). Untracked new files show up in `status_lines` but are not counted here. */
  files_changed: number;
  insertions: number;
  deletions: number;
  /** Raw `git status --porcelain` lines — covers modified, added, deleted, and untracked ("??") paths. */
  status_lines: string[];
}

const EMPTY_DIFF_SUMMARY: GitDiffSummary = {
  is_repo: false, dirty: false, files_changed: 0, insertions: 0, deletions: 0, status_lines: [],
};

// Post-run verification: "what did the last operation change on disk?"
// Combines `git status --porcelain` (catches untracked files) with
// `git diff --stat HEAD` (catches insertion/deletion counts for tracked
// changes) so a caller gets both "what paths changed" and "how much".
export async function gitDiffSummary(root: string): Promise<GitDiffSummary> {
  if (!(await isGitRepo(root))) return EMPTY_DIFF_SUMMARY;

  const [statusRaw, diffStatRaw] = await Promise.all([
    safeGitRaw(root, ["status", "--porcelain"]),
    safeGitRaw(root, ["diff", "--stat", "HEAD"]),
  ]);
  const status_lines = statusRaw ? statusRaw.split(/\r?\n/).filter(Boolean) : [];

  // Last line of `git diff --stat` looks like:
  //   " 3 files changed, 42 insertions(+), 7 deletions(-)"
  const summaryLine = diffStatRaw.split(/\r?\n/).filter(Boolean).pop() ?? "";
  const filesM = /(\d+) files? changed/.exec(summaryLine);
  const insM = /(\d+) insertions?\(\+\)/.exec(summaryLine);
  const delM = /(\d+) deletions?\(-\)/.exec(summaryLine);

  return {
    is_repo: true,
    dirty: status_lines.length > 0,
    files_changed: filesM ? Number(filesM[1]) : 0,
    insertions: insM ? Number(insM[1]) : 0,
    deletions: delM ? Number(delM[1]) : 0,
    status_lines,
  };
}
