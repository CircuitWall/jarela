// Skills loader — reads packaged built-in skills plus user SKILL.md files
// from the repos in the `skill_repos` table (lib/stores/skill-repos.ts,
// ADR-0074).
//
// Supported layouts (both may coexist):
//   repoPath/skill-name/SKILL.md   ← Claude-style (directory per skill)
//   repoPath/skill-name.md         ← flat .md files
//
// Repos are scanned in created_at order; a later repo's skill wins over an
// earlier repo's (and over built-ins) when ids collide. Writes and deletes
// always target the one repo flagged `writable` in the DB, so the rest can
// be read-only clones of shared skill sets.
//
// Writing always uses the Claude-style layout so output is compatible with
// VS Code Copilot and any other tool that discovers skills by SKILL.md.
//
// Synchronous I/O is intentional: the caller (system-prompt assembly) is
// synchronous, and skill directories are small enough that readFileSync
// overhead is negligible per turn.

import { readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync, rmdirSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { listEnabledSkillRepos, getWritableSkillRepo } from "@/lib/stores/skill-repos";
import { createKeyedCache } from "@/lib/cache/keyed-cache";

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "user";
}

export interface SkillWithContent extends Skill {
  content: string;
}

// All enabled skill repo paths, in override order (later wins on id collision).
export function getSkillsDirs(): readonly string[] {
  return listEnabledSkillRepos().map((r) => r.path);
}

// The writable skill repo's path, or "" if none is configured.
export function getSkillsDir(): string {
  return getWritableSkillRepo()?.path ?? "";
}

export function getBuiltinSkillsDir(): string {
  return path.join(process.cwd(), "lib", "skills", "builtins");
}

function unquoteYaml(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).trim();
  }
  return v;
}

// SKILL.md files in the VS Code/Claude format carry name/description in YAML frontmatter.
function parseFrontmatter(lines: string[]): { fields: Record<string, string>; bodyStart: number } {
  if (lines[0]?.trim() !== "---") return { fields: {}, bodyStart: 0 };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) return { fields: {}, bodyStart: 0 };
  const fields: Record<string, string> = {};
  const body = lines.slice(1, end);
  for (let i = 0; i < body.length; i++) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(body[i]);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    const block = /^([|>])[+-]?\d?$/.exec(value);
    if (!block) {
      fields[key] = unquoteYaml(value);
      continue;
    }
    // Block scalar: collect the following indented (or blank) lines.
    const parts: string[] = [];
    while (i + 1 < body.length && (body[i + 1].trim() === "" || /^\s/.test(body[i + 1]))) {
      parts.push(body[++i].trim());
    }
    // Agents see descriptions as one line, so both folded and literal styles are joined.
    fields[key] = parts.filter(Boolean).join(" ");
  }
  return { fields, bodyStart: end + 1 };
}

function parseSkill(id: string, content: string, source: Skill["source"]): Skill {
  const lines = content.split(/\r?\n/);
  const { fields, bodyStart } = parseFrontmatter(lines);
  let name = id;
  const descParts: string[] = [];
  let headingFound = false;

  for (const line of lines.slice(bodyStart)) {
    if (!headingFound && line.startsWith("# ")) {
      name = line.slice(2).trim();
      headingFound = true;
      continue;
    }
    if (headingFound) {
      if (line.startsWith("#")) break;
      if (line.trim() === "" && descParts.length > 0) break;
      if (line.trim()) descParts.push(line.trim());
    }
  }

  return {
    id,
    name: fields.name || name,
    description: (fields.description || descParts.join(" ")).slice(0, 200),
    source,
  };
}

// listSkills() readdirs every skill repo and reads each SKILL.md, and the
// system prompt calls it on every turn — measured at 1.85 ms for 3 skills,
// ~60% of prompt assembly, because the cost is disk rather than row count.
// Same shape as the drop-in tool cache in lib/tools/external.ts: a short TTL
// so hand-edited files still appear promptly, plus explicit invalidation from
// the in-process write paths so write_skill is visible on the very next turn.
// listSkills() readdirs every skill repo and reads each SKILL.md, and the
// system prompt calls it on every turn — measured at 1.85 ms for 3 skills,
// ~60% of prompt assembly, because the cost is disk rather than row count.
// The key covers repo enable/disable, which changes the result without
// touching any skill file; the TTL only bounds hand edits made outside the app.
const skillsCache = createKeyedCache<Skill[]>({
  ttlMs: 5_000,
  key: () => [getBuiltinSkillsDir(), ...getSkillsDirs()].join("|"),
  load: () => {
    const byId = new Map<string, Skill>();
    for (const skill of readSkillsFromDir(getBuiltinSkillsDir(), "builtin")) {
      byId.set(skill.id, skill);
    }
    for (const dir of getSkillsDirs()) {
      for (const skill of readSkillsFromDir(dir, "user")) {
        byId.set(skill.id, skill);
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  },
});

/** Drop the cached skill list. Call after any write to a skill repo. */
export function invalidateSkillsCache(): void {
  skillsCache.invalidate();
}

export function listSkills(): Skill[] {
  return skillsCache.get();
}

function readSkillsFromDir(dir: string, source: Skill["source"]): Skill[] {
  if (!dir || !existsSync(dir)) return [];

  let entries: { name: string; isDir: boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    }));
  } catch {
    return [];
  }

  const skills: Skill[] = [];

  for (const entry of entries) {
    if (entry.isDir) {
      const skillFile = path.join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      try {
        const content = readFileSync(skillFile, "utf8");
        skills.push(parseSkill(entry.name, content, source));
      } catch { /* skip unreadable */ }
    } else if (entry.name.endsWith(".md")) {
      const id = entry.name.slice(0, -3);
      try {
        const content = readFileSync(path.join(dir, entry.name), "utf8");
        skills.push(parseSkill(id, content, source));
      } catch { /* skip unreadable */ }
    }
  }

  return skills;
}

export function getSkill(id: string): SkillWithContent | null {
  return resolveSkill(id)?.skill ?? null;
}

export function resolveSkill(id: string): { skill: SkillWithContent; directory: string | null } | null {
  if (!sanitizeId(id)) return null;

  // Later directories override earlier ones, so search in reverse.
  const dirs = getSkillsDirs();
  for (let i = dirs.length - 1; i >= 0; i--) {
    const user = readSkillFromDir(dirs[i], id, "user");
    if (user) return user;
  }
  return readSkillFromDir(getBuiltinSkillsDir(), id, "builtin");
}

function readSkillFromDir(dir: string, id: string, source: Skill["source"]): ReturnType<typeof resolveSkill> {
  if (!dir) return null;

  // Claude-style first
  const claudeFile = path.join(dir, id, "SKILL.md");
  if (existsSync(claudeFile)) {
    try {
      const content = readFileSync(claudeFile, "utf8");
      return { skill: { ...parseSkill(id, content, source), content }, directory: path.join(dir, id) };
    } catch { /* fall through */ }
  }

  // Flat .md
  const flatFile = path.join(dir, `${id}.md`);
  if (existsSync(flatFile)) {
    try {
      const content = readFileSync(flatFile, "utf8");
      return { skill: { ...parseSkill(id, content, source), content }, directory: null };
    } catch { /* not found */ }
  }

  return null;
}

export function writeSkill(id: string, content: string): void {
  const dir = getSkillsDir();
  if (!dir) throw new Error("No writable skill repo is configured");
  if (!sanitizeId(id)) throw new Error(`Invalid skill id: ${JSON.stringify(id)}`);

  const skillDir = path.join(dir, id);
  const skillFile = path.join(skillDir, "SKILL.md");

  // Path escape guard
  const resolvedBase = path.resolve(dir);
  if (!path.resolve(skillFile).startsWith(resolvedBase + path.sep)) {
    throw new Error("Path escape detected");
  }

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillFile, content, "utf8");
  invalidateSkillsCache();
}

export function deleteSkill(id: string): boolean {
  const dir = getSkillsDir();
  if (!dir || !sanitizeId(id)) return false;

  const claudeFile = path.join(dir, id, "SKILL.md");
  if (existsSync(claudeFile)) {
    try {
      rmSync(claudeFile);
      try { rmdirSync(path.join(dir, id)); } catch { /* not empty */ }
      invalidateSkillsCache();
      return true;
    } catch { /* fall through */ }
  }

  const flatFile = path.join(dir, `${id}.md`);
  if (existsSync(flatFile)) {
    try { rmSync(flatFile); invalidateSkillsCache(); return true; } catch { /* ignore */ }
  }

  return false;
}

function sanitizeId(id: string): boolean {
  return Boolean(id) && /^[\w-]+$/.test(id) && !id.includes("..") && !id.includes("/") && !id.includes("\\");
}
