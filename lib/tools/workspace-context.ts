// workspace_context — one-shot repo context gatherer for the developer agent.
//
// Mirrors the "harness" a code-aware IDE chat assembles before each turn:
// project tree (depth-limited), git status + recent commits, package
// metadata, README head, and grep-based hits for the user's query. Returns
// a single JSON bundle so the agent can ground a coding answer in real
// repo state without a manual chain of file_list / file_read / exec calls.
//
// Read-only. Honors the same FS denylist and safety gate as file_read.
// Output is hard-capped at ~24 KB to protect the prompt budget — every
// section trims independently before the bundle is assembled.

import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerTools } from "./registry";
import { checkFsAllowed, resolveSafetyMode } from "./safety";

// Credential subtrees and files the agent must never enumerate, even read-only.
// Mirrors lib/tools/files.ts:assertSafePath so workspace_context cannot be used
// as a sidedoor around that gate. JARELA_ALLOW_SENSITIVE_FILES=1 still opts out.
function sensitiveBases(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".config", "gh"),
    path.join(home, ".kube"),
    path.join(home, ".docker"),
  ];
}

function isInside(abs: string, parent: string): boolean {
  const a = path.resolve(abs);
  const p = path.resolve(parent);
  if (a === p) return true;
  const rel = path.relative(p, a);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const SECTIONS = ["tree", "git", "package", "readme", "hits"] as const;
type Section = (typeof SECTIONS)[number];

const MAX_BUNDLE_BYTES = 24_000;
const MAX_TREE_ENTRIES = 200;
const MAX_TREE_DEPTH = 3;
const MAX_HITS = 30;
const MAX_HIT_LINE_BYTES = 240;
const MAX_README_LINES = 80;
const MAX_FILES_SCANNED_FOR_HITS = 1500;
const GIT_TIMEOUT_MS = 4_000;

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", ".cache", ".parcel-cache",
  "dist", "build", "out", "coverage", "target", "vendor",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  "venv", ".venv", "env", ".env.d",
  ".idea", ".vscode-test", ".gradle",
]);

const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".jsonc", ".md", ".mdx", ".txt", ".yml", ".yaml", ".toml",
  ".css", ".scss", ".html", ".svg",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh", ".ps1", ".sql",
]);

function resolvePath(p: string): string {
  if (!p.trim()) throw new Error("path is required");
  let s = p.trim();
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    return path.resolve(path.join(os.homedir(), s.slice(2)));
  }
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(os.homedir(), s);
}

function assertReadable(abs: string): void {
  const mode = resolveSafetyMode();
  const gate = checkFsAllowed("read", { mode });
  if (!gate.allowed) throw new Error(gate.reason);
  if (mode === "bypass") return;
  if (process.env.JARELA_ALLOW_SENSITIVE_FILES === "1") return;
  for (const base of sensitiveBases()) {
    if (isInside(abs, base)) {
      throw new Error(
        `refused: '${abs}' is inside a credential directory (${path.basename(base)}). ` +
          `Set JARELA_ALLOW_SENSITIVE_FILES=1 to override.`,
      );
    }
  }
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1_000_000,
    });
    return out.trim();
  } catch {
    return null;
  }
}

interface TreeNode {
  name: string;
  kind: "file" | "directory";
  children?: TreeNode[];
  truncated?: boolean;
}

async function buildTree(root: string): Promise<{ tree: TreeNode; entries: number; truncated: boolean }> {
  let count = 0;
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<TreeNode[]> {
    if (depth > MAX_TREE_DEPTH || count >= MAX_TREE_ENTRIES) return [];
    let items: import("node:fs").Dirent[];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    items.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const out: TreeNode[] = [];
    for (const it of items) {
      if (count >= MAX_TREE_ENTRIES) { truncated = true; break; }
      if (it.name.startsWith(".") && it.name !== ".github") continue;
      if (IGNORED_DIRS.has(it.name)) continue;
      count++;
      if (it.isDirectory()) {
        const children = await walk(path.join(dir, it.name), depth + 1);
        out.push({ name: it.name, kind: "directory", children });
      } else if (it.isFile()) {
        out.push({ name: it.name, kind: "file" });
      }
    }
    return out;
  }

  const children = await walk(root, 1);
  return {
    tree: { name: path.basename(root) || root, kind: "directory", children, truncated },
    entries: count,
    truncated,
  };
}

interface GitInfo {
  is_repo: boolean;
  branch?: string;
  status?: string[];
  recent_commits?: string[];
  remote?: string;
}

function gatherGit(cwd: string): GitInfo {
  const top = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return { is_repo: false };
  const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? undefined;
  const statusRaw = runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  const status = statusRaw
    ? statusRaw.split(/\r?\n/).filter(Boolean).slice(0, 40)
    : [];
  const commitsRaw = runGit(cwd, ["log", "--oneline", "-n", "8"]);
  const recent = commitsRaw ? commitsRaw.split(/\r?\n/).filter(Boolean) : [];
  const remote = runGit(cwd, ["config", "--get", "remote.origin.url"]) ?? undefined;
  return { is_repo: true, branch, status, recent_commits: recent, remote };
}

async function gatherPackage(root: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = pkg.dependencies && typeof pkg.dependencies === "object"
      ? Object.keys(pkg.dependencies as Record<string, unknown>) : [];
    const devDeps = pkg.devDependencies && typeof pkg.devDependencies === "object"
      ? Object.keys(pkg.devDependencies as Record<string, unknown>) : [];
    return {
      name: pkg.name,
      version: pkg.version,
      type: pkg.type,
      scripts: pkg.scripts,
      dependencies: deps.slice(0, 40),
      devDependencies: devDeps.slice(0, 40),
      dep_count: deps.length,
      devdep_count: devDeps.length,
    };
  } catch {
    return null;
  }
}

async function gatherReadme(root: string): Promise<string | null> {
  for (const name of ["README.md", "README.MD", "Readme.md", "readme.md", "README"]) {
    try {
      const raw = await fs.readFile(path.join(root, name), "utf8");
      return raw.split(/\r?\n/).slice(0, MAX_README_LINES).join("\n");
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function tokenizeQuery(q: string): string[] {
  return Array.from(new Set(
    q
      .split(/[\s,.;:!?()[\]{}"'`<>]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3)
      .map((t) => t.toLowerCase()),
  )).slice(0, 8);
}

async function listCandidateFiles(root: string, useGit: boolean): Promise<string[]> {
  if (useGit) {
    const out = runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard"]);
    if (out) {
      return out.split(/\r?\n/).filter(Boolean).map((p) => path.join(root, p));
    }
  }
  // Fallback: bounded walk
  const result: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6 || result.length >= MAX_FILES_SCANNED_FOR_HITS) return;
    let items: import("node:fs").Dirent[];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const it of items) {
      if (result.length >= MAX_FILES_SCANNED_FOR_HITS) return;
      if (it.name.startsWith(".")) continue;
      if (IGNORED_DIRS.has(it.name)) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) await walk(full, depth + 1);
      else if (it.isFile()) result.push(full);
    }
  }
  await walk(root, 1);
  return result;
}

async function gatherHits(root: string, query: string, useGit: boolean): Promise<Hit[]> {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const files = await listCandidateFiles(root, useGit);
  const hits: Hit[] = [];
  let scanned = 0;
  for (const file of files) {
    if (hits.length >= MAX_HITS) break;
    if (scanned >= MAX_FILES_SCANNED_FOR_HITS) break;
    const ext = path.extname(file).toLowerCase();
    if (ext && !TEXT_EXTS.has(ext)) continue;
    scanned++;
    let content: string;
    try {
      const buf = await fs.readFile(file);
      if (buf.length > 200_000) continue;
      if (buf.includes(0)) continue;
      content = buf.toString("utf8");
    } catch { continue; }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      if (tokens.some((t) => lower.includes(t))) {
        const text = lines[i].length > MAX_HIT_LINE_BYTES
          ? lines[i].slice(0, MAX_HIT_LINE_BYTES) + "…"
          : lines[i];
        hits.push({ file: path.relative(root, file).replace(/\\/g, "/"), line: i + 1, text });
        if (hits.length >= MAX_HITS) break;
      }
    }
  }
  return hits;
}

const schema = z.object({
  cwd: z
    .string()
    .describe("Absolute path (or ~/foo) to the workspace/repo root. Bare relative paths resolve against HOME."),
  query: z
    .string()
    .optional()
    .describe("The user's question or topic. Used to grep top-k matching lines across the repo. Omit to skip the 'hits' section."),
  include: z
    .array(z.enum(SECTIONS))
    .optional()
    .describe("Subset of sections to include. Defaults to all: tree, git, package, readme, hits."),
});

export const workspaceContextTool = tool(
  async ({ cwd, query, include }) => {
    let root: string;
    try {
      root = resolvePath(cwd);
      assertReadable(root);
      const st = await fs.stat(root);
      if (!st.isDirectory()) throw new Error("cwd must be a directory");
    } catch (err) {
      return JSON.stringify({ ok: false, cwd, error: (err as Error).message });
    }

    const want = new Set<Section>(include && include.length > 0 ? include : SECTIONS);

    // Always probe git when hits are wanted so gatherHits can use ls-files
    // even if the caller excluded the 'git' section from the bundle.
    const needGitProbe = want.has("git") || want.has("hits");
    const gitInfo: GitInfo = needGitProbe ? gatherGit(root) : { is_repo: false };

    const [tree, pkg, readme, hits] = await Promise.all([
      want.has("tree") ? buildTree(root) : Promise.resolve(null),
      want.has("package") ? gatherPackage(root) : Promise.resolve(null),
      want.has("readme") ? gatherReadme(root) : Promise.resolve(null),
      want.has("hits") && query ? gatherHits(root, query, gitInfo.is_repo) : Promise.resolve([] as Hit[]),
    ]);

    const bundle: Record<string, unknown> = {
      ok: true,
      root,
      sections_included: Array.from(want),
    };
    if (want.has("tree") && tree) bundle.tree = tree;
    if (want.has("git")) bundle.git = gitInfo;
    if (want.has("package")) bundle.package = pkg;
    if (want.has("readme")) bundle.readme = readme;
    if (want.has("hits") && query) bundle.hits = hits;

    // Hard byte cap: shrink heaviest sections first (hits → readme → tree).
    let json = JSON.stringify(bundle);
    if (json.length > MAX_BUNDLE_BYTES) {
      if (Array.isArray(bundle.hits) && (bundle.hits as Hit[]).length > 5) {
        const trimmed = (bundle.hits as Hit[]).slice(0, Math.max(5, Math.floor((bundle.hits as Hit[]).length / 2)));
        bundle.hits = trimmed;
        bundle.hits_truncated = true;
        json = JSON.stringify(bundle);
      }
    }
    if (json.length > MAX_BUNDLE_BYTES && bundle.readme) {
      const half = (bundle.readme as string).split(/\r?\n/).slice(0, 30).join("\n");
      bundle.readme = half;
      bundle.readme_truncated = true;
      json = JSON.stringify(bundle);
    }
    if (json.length > MAX_BUNDLE_BYTES && bundle.tree) {
      // Drop tree as last resort; it tends to dominate
      bundle.tree = { note: "tree omitted to fit byte cap; call file_list to explore subdirs" };
      bundle.tree_truncated = true;
      json = JSON.stringify(bundle);
    }
    return json;
  },
  {
    name: "workspace_context",
    description:
      "Gather a one-shot context bundle for a code question about a local repo: directory tree (depth-limited), git status + recent commits, package.json summary, README head, and grep-based 'hits' for your query. CALL THIS FIRST when answering a coding question or planning edits against a workspace. Read-only. Pass cwd=absolute repo root and query=user's question.",
    schema,
  },
);

registerTools("Files", "read", [workspaceContextTool]);
