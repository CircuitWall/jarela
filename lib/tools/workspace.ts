// `workspace_init` / `workspace_status` / `workspace_close`.
//
// Single agent-driven entry point for "I am working in this directory".
// Returns a context bundle so the agent doesn't have to make a dozen
// exploratory shell calls before it can start working: git state,
// detected language / package manager / scripts, README head,
// convention files (CLAUDE.md, CONTRIBUTING.md, ADR dir).
//
// Once set, every `file_*` and `local_exec` call with a relative path
// resolves against the workspace root instead of the user's HOME.
// Absolute paths are honoured as-is. Set `scoped: true` to refuse
// absolute paths outside the root (off by default so the agent can
// still read e.g. ~/Downloads to copy a file into the project).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "./langchain-package";
import {
  currentWorkspace,
  setWorkspace,
  clearWorkspace,
  type ToolConfig,
} from "./workspace-context";
import { probeGit, type GitProbe } from "./git-probe";

// Probe budget. Keep generous enough for slow filesystems but short
// enough that the agent isn't blocked for tens of seconds on a stalled
// cloud-sync provider.
const PROBE_TIMEOUT_MS = 8_000;

const MAX_TREE_DEFAULT = 200;
const MAX_TREE_HARD_CAP = 1_000;
const README_MAX_BYTES = 2_048;

// Reuse the credential denylist shape from files.ts — keep this list in
// sync if files.ts grows new sensitive bases. We intentionally don't
// import from files.ts to avoid a tight coupling; workspace_init is the
// only place where the *whole root* is gated (file tools gate per call).
function sensitiveRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".config", "gh"),
    path.join(home, ".kube"),
    path.join(home, ".docker"),
    process.env.JARELA_DB_DIR
      ? path.resolve(process.env.JARELA_DB_DIR)
      : path.join(home, ".jarela"),
  ];
}

function isInside(abs: string, parent: string): boolean {
  const a = path.resolve(abs);
  const p = path.resolve(parent);
  if (a === p) return true;
  const rel = path.relative(p, a);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveAgentPath(p: string): string {
  let s = p.trim();
  if (!s) throw new Error("path is required");
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    s = path.join(os.homedir(), s.slice(2));
    return path.resolve(s);
  }
  if (path.isAbsolute(s)) return path.resolve(s);
  return path.resolve(os.homedir(), s);
}

async function withTimeout<T>(label: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${PROBE_TIMEOUT_MS}ms`)),
      PROBE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

async function readJsonIfExists(p: string): Promise<PackageManifest | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as PackageManifest;
  } catch {
    return null;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(root: string, pkg: PackageManifest | null): Promise<string> {
  if (pkg?.packageManager) {
    const pm = pkg.packageManager.split("@")[0];
    if (pm) return pm;
  }
  if (await fileExists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(path.join(root, "yarn.lock"))) return "yarn";
  if (await fileExists(path.join(root, "bun.lockb"))) return "bun";
  if (await fileExists(path.join(root, "package-lock.json"))) return "npm";
  if (await fileExists(path.join(root, "Pipfile"))) return "pipenv";
  if (await fileExists(path.join(root, "poetry.lock"))) return "poetry";
  if (await fileExists(path.join(root, "requirements.txt"))) return "pip";
  if (await fileExists(path.join(root, "Cargo.toml"))) return "cargo";
  if (await fileExists(path.join(root, "go.mod"))) return "go";
  return "none";
}

function detectTestRunner(pkg: PackageManifest | null): string | undefined {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (deps.vitest) return "vitest";
  if (deps.jest) return "jest";
  if (deps.mocha) return "mocha";
  if (deps.ava) return "ava";
  if (pkg?.scripts?.test) return "npm:test";
  return undefined;
}

function detectFrameworks(pkg: PackageManifest | null): string[] {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const out: string[] = [];
  if (deps.next) out.push("next");
  if (deps.react) out.push("react");
  if (deps.vue) out.push("vue");
  if (deps.svelte) out.push("svelte");
  if (deps["@angular/core"]) out.push("angular");
  if (deps.express) out.push("express");
  if (deps.fastify) out.push("fastify");
  if (deps.tailwindcss) out.push("tailwind");
  if (deps["@langchain/core"]) out.push("langchain");
  return out;
}

async function parseMakefileTargets(root: string): Promise<string[]> {
  const p = path.join(root, "Makefile");
  try {
    const raw = await fs.readFile(p, "utf8");
    const targets: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      // Match `target:` or `target: dep1 dep2` but skip variable assignments
      // and indented recipe lines.
      const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
      if (m && !line.startsWith("\t")) targets.push(m[1]);
    }
    // Dedupe preserving order; cap at 50.
    return Array.from(new Set(targets)).slice(0, 50);
  } catch {
    return [];
  }
}

async function detectLanguages(root: string): Promise<string[]> {
  const found = new Set<string>();
  // Quick scan: top-level + one level of children. Avoids full recursive walk.
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      if (e.isFile()) markLanguage(e.name, found);
    }
    if (await fileExists(path.join(root, "tsconfig.json"))) found.add("typescript");
    if (await fileExists(path.join(root, "go.mod"))) found.add("go");
    if (await fileExists(path.join(root, "Cargo.toml"))) found.add("rust");
    if (await fileExists(path.join(root, "pyproject.toml"))) found.add("python");
    if (await fileExists(path.join(root, "pom.xml"))) found.add("java");
    if (await fileExists(path.join(root, "build.gradle")) || await fileExists(path.join(root, "build.gradle.kts"))) found.add("java");
  } catch {
    /* ignore */
  }
  return Array.from(found);
}

function markLanguage(filename: string, into: Set<string>): void {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java", ".kt": "kotlin",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".swift": "swift",
  };
  const l = map[ext];
  if (l) into.add(l);
}

// Lightweight directory tree honouring a small ignore list. We don't
// fully parse .gitignore — that's a heavy dep for this probe; the
// default ignores cover the 95% case (node_modules, .git, dist, build,
// .next, coverage, __pycache__, target, vendor). Returns at most
// `maxEntries` rows; sets `truncated=true` if more existed.
interface TreeEntry {
  path: string;
  kind: "file" | "dir";
  size?: number;
}

const DEFAULT_IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out",
  "coverage", "__pycache__", "target", "vendor", ".venv", "venv",
  ".turbo", ".cache", ".idea", ".vscode",
]);

async function buildTree(
  root: string,
  maxEntries: number,
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const entries: TreeEntry[] = [];
  let truncated = false;

  async function walk(dirAbs: string, dirRel: string, depth: number): Promise<void> {
    if (entries.length >= maxEntries) {
      truncated = true;
      return;
    }
    if (depth > 4) return; // hard depth cap to keep probe bounded
    let kids: import("node:fs").Dirent[];
    try {
      kids = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    kids.sort((a, b) => {
      // dirs first, then files; alpha within group
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const k of kids) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      if (DEFAULT_IGNORE.has(k.name)) continue;
      const childAbs = path.join(dirAbs, k.name);
      const childRel = dirRel ? `${dirRel}/${k.name}` : k.name;
      if (k.isDirectory()) {
        entries.push({ path: `${childRel}/`, kind: "dir" });
        await walk(childAbs, childRel, depth + 1);
      } else if (k.isFile()) {
        let size: number | undefined;
        try {
          const st = await fs.stat(childAbs);
          size = st.size;
        } catch {
          /* ignore */
        }
        entries.push({ path: childRel, kind: "file", size });
      }
    }
  }

  await walk(root, "", 0);
  return { entries, truncated };
}

async function readReadme(root: string): Promise<{ path: string; head: string; truncated: boolean } | null> {
  try {
    const entries = await fs.readdir(root);
    const candidate = entries.find((e) => /^readme(\.[a-z0-9]+)?$/i.test(e));
    if (!candidate) return null;
    const abs = path.join(root, candidate);
    const raw = await fs.readFile(abs, "utf8");
    const head = raw.slice(0, README_MAX_BYTES);
    return { path: candidate, head, truncated: raw.length > README_MAX_BYTES };
  } catch {
    return null;
  }
}

async function detectConventionFiles(root: string): Promise<{
  claude_md: string | null;
  agents_md: string | null;
  copilot_instructions_md: string | null;
  instruction_files: string[];
  skill_files: string[];
  contributing_md: string | null;
  adr_dir: string | null;
}> {
  const claude = (await fileExists(path.join(root, "CLAUDE.md"))) ? "CLAUDE.md" : null;
  const agents = (await fileExists(path.join(root, "AGENTS.md"))) ? "AGENTS.md" : null;
  const copilot = (await fileExists(path.join(root, ".github", "copilot-instructions.md"))) ? ".github/copilot-instructions.md" : null;
  const instructionFiles = await listConventionFiles(root, ".github/instructions", (name) => name.endsWith(".instructions.md"));
  const skillFiles = await listSkillFiles(root);
  const contributing = (await fileExists(path.join(root, "CONTRIBUTING.md"))) ? "CONTRIBUTING.md" : null;
  // ADR dir conventions: docs/adr, docs/decisions, adr
  let adrDir: string | null = null;
  for (const candidate of ["docs/adr", "docs/decisions", "adr"]) {
    if (await fileExists(path.join(root, candidate))) {
      adrDir = candidate;
      break;
    }
  }
  return {
    claude_md: claude,
    agents_md: agents,
    copilot_instructions_md: copilot,
    instruction_files: instructionFiles,
    skill_files: skillFiles,
    contributing_md: contributing,
    adr_dir: adrDir,
  };
}

async function listConventionFiles(root: string, dirRel: string, accept: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(root, dirRel), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && accept(entry.name))
      .map((entry) => `${dirRel}/${entry.name}`)
      .sort()
      .slice(0, 50);
  } catch {
    return [];
  }
}

async function listSkillFiles(root: string): Promise<string[]> {
  const bases = [".github/skills", ".agents/skills", ".claude/skills"];
  const found: string[] = [];
  for (const base of bases) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(root, base), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && await fileExists(path.join(root, base, entry.name, "SKILL.md"))) {
        found.push(`${base}/${entry.name}/SKILL.md`);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        found.push(`${base}/${entry.name}`);
      }
      if (found.length >= 50) return found.sort();
    }
  }
  return found.sort();
}

// Build the prioritised required-reading list the agent MUST read before
// taking any other action. Order matters — earlier entries are higher
// priority. We resolve each candidate to (relative path, byte size) so
// the agent knows what it's about to spend tokens on.
//
// We deliberately do NOT inline contents here: the agent already has
// file_read for that, the user sees the read calls in the tool stream,
// and large convention files don't get force-loaded on every init.
async function buildRequiredReading(
  root: string,
  conventions: Awaited<ReturnType<typeof detectConventionFiles>>,
  readme: { path: string } | null,
  extra: string[],
): Promise<Array<{ path: string; bytes: number; reason: string }>> {
  const seen = new Set<string>();
  const out: Array<{ path: string; bytes: number; reason: string }> = [];

  const push = async (rel: string | null, reason: string): Promise<void> => {
    if (!rel || seen.has(rel)) return;
    try {
      const st = await fs.stat(path.join(root, rel));
      if (!st.isFile()) return;
      seen.add(rel);
      out.push({ path: rel, bytes: st.size, reason });
    } catch {
      /* file vanished between detect and stat — skip */
    }
  };

  // Priority order:
  //   1. CLAUDE.md / AGENTS.md  — agent-specific operating instructions.
  //   2. Copilot instructions    — repo-local chat/code customizations.
  //   3. CONTRIBUTING.md         — contribution + commit + release rules.
  //   4. README.md               — project overview & invariants.
  //   5. Top-level ADR index     — architectural decisions if a docs/adr exists.
  //   6. Caller-supplied extras  — project-specific must-reads.
  await push(conventions.claude_md, "agent operating instructions");
  await push(conventions.agents_md, "agent operating instructions");
  await push(conventions.copilot_instructions_md, "copilot repository instructions");
  for (const rel of conventions.instruction_files) {
    await push(rel, "copilot file instructions");
  }
  await push(conventions.contributing_md, "contribution + commit + release rules");
  await push(readme?.path ?? null, "project overview");

  if (conventions.adr_dir) {
    for (const idx of ["README.md", "index.md", "0000-index.md"]) {
      const rel = `${conventions.adr_dir}/${idx}`;
      await push(rel, "architectural decision records (index)");
    }
  }

  for (const extraPath of extra) {
    const cleaned = extraPath.trim();
    if (!cleaned) continue;
    // Refuse absolute paths or parent-escape — required_reading is always
    // workspace-relative so the agent can't be coaxed into reading
    // /etc/passwd via a prompt-injected init call.
    if (path.isAbsolute(cleaned) || cleaned.startsWith("..") || cleaned.split(/[\\/]/).includes("..")) {
      continue;
    }
    await push(cleaned.replace(/\\/g, "/"), "caller-supplied");
  }

  return out;
}

function buildRecommendedNextSteps(input: {
  requiredReading: readonly { path: string }[];
  includeTree: boolean;
  treeTruncated: boolean;
  scripts: Record<string, string>;
  makefileTargets: readonly string[];
  skillFiles: readonly string[];
  git: GitProbe;
}): string[] {
  const steps: string[] = [];
  if (input.requiredReading.length > 0) {
    steps.push(`Read required docs first with file_read: ${input.requiredReading.map((r) => r.path).join(", ")}.`);
  }
  if (!input.includeTree || input.treeTruncated) {
    steps.push("Use file_glob to narrow file discovery before reading files.");
  }
  steps.push("Use file_grep with a glob filter for code search; prefer file_read line ranges from grep/outline results over shell cat/type/Get-Content.");
  steps.push("Use file_edit for one targeted edit and file_multi_edit for multiple edits in the same file; avoid shell heredocs for file writes.");
  if (input.skillFiles.length > 0) {
    steps.push(`Repo skills detected: ${input.skillFiles.slice(0, 8).join(", ")}. Before specialized work, read the matching SKILL.md or use list_skills/read_skill when the skill appears in the system prompt.`);
  } else {
    steps.push("Check the system prompt's Available skills list and call read_skill for any skill that matches the task before acting.");
  }
  if (Object.keys(input.scripts).length > 0 || input.makefileTargets.length > 0) {
    steps.push("Use local_exec for focused package scripts, make targets, git, and test commands; use terminal_exec only for persistent interactive sessions or watchers.");
  }
  if (input.git.is_repo) {
    steps.push("Check git status before edits and before commits; do not overwrite unrelated user changes.");
  }
  return steps;
}

// --- init ---------------------------------------------------------------

const initSchema = z.object({
  path: z.string().describe("Project root directory. Absolute or ~/foo; bare relative paths resolve against the user's HOME."),
  scoped: z.boolean().optional().describe("When true, later file_*/local_exec calls refuse absolute paths outside the root. Default false."),
  include_tree: z.boolean().optional().describe("Include a bounded directory tree in the response. Default true."),
  max_tree_entries: z.number().int().min(0).max(MAX_TREE_HARD_CAP).optional().describe(`Cap on tree rows. Default ${MAX_TREE_DEFAULT}, max ${MAX_TREE_HARD_CAP}.`),
  include_git: z.boolean().optional().describe("Probe git state. Default true."),
  include_scripts: z.boolean().optional().describe("Parse package.json scripts and Makefile targets. Default true."),
  include_readme: z.boolean().optional().describe("Return the head of the project README. Default true."),
  extra_required_reading: z
    .array(z.string())
    .optional()
    .describe("Additional workspace-relative paths to append to required_reading. Absolute paths and '..' segments are rejected."),
});

type WorkspaceProbe = {
  git: GitProbe;
  languages: Awaited<ReturnType<typeof detectLanguages>>;
  packageManager: Awaited<ReturnType<typeof detectPackageManager>> | "none";
  makefileTargets: string[];
  tree: { entries: TreeEntry[]; truncated: boolean };
  readme: Awaited<ReturnType<typeof readReadme>>;
  conventions: Awaited<ReturnType<typeof detectConventionFiles>>;
  hasDockerfile: boolean;
  hasDevcontainer: boolean;
};

// Validates the user-supplied path: must resolve cleanly, exist, be a
// directory, and (unless explicitly allowed) not be inside a sensitive root.
async function validateWorkspacePath(
  rawPath: string,
): Promise<{ abs: string } | { error: string }> {
  let abs: string;
  try {
    abs = resolveAgentPath(rawPath);
  } catch (err) {
    return { error: JSON.stringify({ ok: false, error: (err as Error).message, code: "WORKSPACE_BAD_PATH" }) };
  }
  let stat: import("node:fs").Stats;
  try {
    stat = await withTimeout("workspace_init.stat", fs.stat(abs));
  } catch (err) {
    const msg = (err as Error).message;
    const code = msg.includes("ENOENT") ? "WORKSPACE_NOT_FOUND" : msg.includes("timed out") ? "WORKSPACE_TIMEOUT" : "WORKSPACE_ERROR";
    return { error: JSON.stringify({ ok: false, path: abs, error: msg, code }) };
  }
  if (!stat.isDirectory()) {
    return { error: JSON.stringify({ ok: false, path: abs, error: "path is not a directory", code: "WORKSPACE_NOT_DIR" }) };
  }
  // Sensitive-root guard. Override by setting JARELA_ALLOW_SENSITIVE_FILES=1
  // (same opt-out as the per-file denylist in files.ts).
  if (process.env.JARELA_ALLOW_SENSITIVE_FILES !== "1") {
    for (const base of sensitiveRoots()) {
      if (isInside(abs, base)) {
        return { error: JSON.stringify({
          ok: false,
          path: abs,
          error: `refused: '${abs}' is inside a sensitive directory (${path.basename(base)}). Set JARELA_ALLOW_SENSITIVE_FILES=1 to override.`,
          code: "WORKSPACE_SENSITIVE",
        }) };
      }
    }
  }
  return { abs };
}

// Probes everything in parallel and tolerates individual failures. Each
// probe is gated on the matching include_* flag so callers can opt out
// (e.g. for a tiny init in an enormous monorepo).
async function probeWorkspace(
  abs: string,
  opts: {
    include_git: boolean;
    include_tree: boolean;
    include_scripts: boolean;
    include_readme: boolean;
    max_tree_entries: number | undefined;
  },
): Promise<WorkspaceProbe & { pkg: Awaited<ReturnType<typeof readJsonIfExists>> }> {
  const pkg = opts.include_scripts ? await readJsonIfExists(path.join(abs, "package.json")) : null;

  const [git, languages, packageManager, makefileTargets, tree, readme, conventions, hasDockerfile, hasDevcontainer] = await Promise.all([
    opts.include_git ? withTimeout("workspace_init.git", probeGit(abs)).catch(() => ({ is_repo: false } as GitProbe)) : Promise.resolve({ is_repo: false } as GitProbe),
    detectLanguages(abs),
    opts.include_scripts ? detectPackageManager(abs, pkg) : Promise.resolve("none" as const),
    opts.include_scripts ? parseMakefileTargets(abs) : Promise.resolve([] as string[]),
    opts.include_tree
      ? buildTree(abs, Math.min(opts.max_tree_entries ?? MAX_TREE_DEFAULT, MAX_TREE_HARD_CAP))
      : Promise.resolve({ entries: [] as TreeEntry[], truncated: false }),
    opts.include_readme ? readReadme(abs) : Promise.resolve(null),
    detectConventionFiles(abs),
    fileExists(path.join(abs, "Dockerfile")),
    fileExists(path.join(abs, ".devcontainer", "devcontainer.json")),
  ]);

  return { git, languages, packageManager, makefileTargets, tree, readme, conventions, hasDockerfile, hasDevcontainer, pkg };
}

export const workspaceInitTool = tool(
  async (input, config?: ToolConfig) => {
    const {
      path: rawPath,
      scoped = false,
      include_tree = true,
      max_tree_entries,
      include_git = true,
      include_scripts = true,
      include_readme = true,
      extra_required_reading = [],
    } = input;

    const validated = await validateWorkspacePath(rawPath);
    if ("error" in validated) return validated.error;
    const { abs } = validated;

    // Install the workspace before probing — so probe-time errors don't
    // leave the agent without an active workspace.
    setWorkspace({ root: abs, scoped, opened_at: Date.now() }, config);

    const probe = await probeWorkspace(abs, {
      include_git, include_tree, include_scripts, include_readme, max_tree_entries,
    });

    const requiredReading = await buildRequiredReading(abs, probe.conventions, probe.readme, extra_required_reading);
    const scripts = probe.pkg?.scripts ?? {};

    return JSON.stringify({
      ok: true,
      root: abs,
      scoped,
      git: probe.git,
      project: {
        languages: probe.languages,
        package_manager: probe.packageManager,
        framework_hints: detectFrameworks(probe.pkg),
        test_runner: detectTestRunner(probe.pkg),
        scripts,
        makefile_targets: probe.makefileTargets,
        has_dockerfile: probe.hasDockerfile,
        has_devcontainer: probe.hasDevcontainer,
      },
      tree: include_tree ? probe.tree : undefined,
      readme: probe.readme,
      conventions: probe.conventions,
      required_reading: requiredReading,
      recommended_next_steps: buildRecommendedNextSteps({
        requiredReading,
        includeTree: include_tree,
        treeTruncated: probe.tree.truncated,
        scripts,
        makefileTargets: probe.makefileTargets,
        skillFiles: probe.conventions.skill_files,
        git: probe.git,
      }),
    });
  },
  {
    name: "workspace_init",
    description:
      "Register a project directory as the active workspace for this thread and return its context bundle (git state, languages, scripts, tree, README head, convention files, required_reading, recommended_next_steps). After this call, file_*/local_exec calls with relative paths resolve against the workspace root instead of $HOME. Call this once at the start of any coding task. CRITICAL: the response includes a `required_reading` array of workspace-relative instruction files (CLAUDE.md, AGENTS.md, .github/copilot-instructions.md, .github/instructions/*.instructions.md, CONTRIBUTING.md, README, ADR index, plus caller-supplied extras). You MUST `file_read` every entry in `required_reading` before taking any other action (no edits, no shell commands, no further tool calls beyond file_read for those paths). Use `recommended_next_steps` to choose relevant repo skills and efficient file/search/shell tools instead of extra exploratory shell commands.",
    schema: initSchema,
  },
);

// --- status -------------------------------------------------------------

export const workspaceStatusTool = tool(
  async (_input, config?: ToolConfig) => {
    const ws = currentWorkspace(config);
    if (!ws) {
      return JSON.stringify({ ok: true, active: false });
    }
    // Re-probe git state cheaply — that's the only field that drifts.
    const git = await probeGit(ws.root).catch(() => ({ is_repo: false } as GitProbe));
    const conventions = await detectConventionFiles(ws.root);
    return JSON.stringify({
      ok: true,
      active: true,
      root: ws.root,
      scoped: ws.scoped,
      opened_at: ws.opened_at,
      git,
      conventions,
      recommended_next_steps: buildRecommendedNextSteps({
        requiredReading: [],
        includeTree: false,
        treeTruncated: false,
        scripts: {},
        makefileTargets: [],
        skillFiles: conventions.skill_files,
        git,
      }),
    });
  },
  {
    name: "workspace_status",
    description:
      "Return the currently active workspace (if any), fresh git status, and recommended next steps. Cheap — no tree walk. Use to check 'am I where I think I am?' before destructive operations, then prefer file_* tools for file work and local_exec only for focused commands.",
    schema: z.object({}).describe("No arguments."),
  },
);

// --- close --------------------------------------------------------------

export const workspaceCloseTool = tool(
  async (_input, config?: ToolConfig) => {
    const cleared = clearWorkspace(config);
    return JSON.stringify({ ok: true, was_active: cleared });
  },
  {
    name: "workspace_close",
    description:
      "Clear the active workspace for this thread. Subsequent file_*/local_exec calls with relative paths return to resolving against $HOME / process cwd.",
    schema: z.object({}).describe("No arguments."),
  },
);

registerLangChainPackage({
  category: "Files",
  tools: { read: [workspaceInitTool, workspaceStatusTool, workspaceCloseTool] },
});
