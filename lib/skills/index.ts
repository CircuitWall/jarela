// Skills loader — reads packaged built-in skills plus user SKILL.md files from
// JARELA_SKILLS_DIR.
//
// Supported layouts (both may coexist):
//   skillsDir/skill-name/SKILL.md   ← Claude-style (directory per skill)
//   skillsDir/skill-name.md         ← flat .md files
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
import { getConfig } from "@/lib/env/config";

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "user";
}

export interface SkillWithContent extends Skill {
  content: string;
}

export function getSkillsDir(): string {
  return getConfig().skillsDir;
}

export function getBuiltinSkillsDir(): string {
  return path.join(process.cwd(), "lib", "skills", "builtins");
}

function parseSkill(id: string, content: string, source: Skill["source"]): Skill {
  const lines = content.split("\n");
  let name = id;
  const descParts: string[] = [];
  let headingFound = false;

  for (const line of lines) {
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

  return { id, name, description: descParts.join(" ").slice(0, 200), source };
}

export function listSkills(): Skill[] {
  const byId = new Map<string, Skill>();
  for (const skill of readSkillsFromDir(getBuiltinSkillsDir(), "builtin")) {
    byId.set(skill.id, skill);
  }

  const dir = getSkillsDir();
  if (dir) {
    for (const skill of readSkillsFromDir(dir, "user")) {
      byId.set(skill.id, skill);
    }
  }

  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
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
  if (!sanitizeId(id)) return null;

  const user = readSkillFromDir(getSkillsDir(), id, "user");
  if (user) return user;
  return readSkillFromDir(getBuiltinSkillsDir(), id, "builtin");
}

function readSkillFromDir(dir: string, id: string, source: Skill["source"]): SkillWithContent | null {
  if (!dir) return null;

  // Claude-style first
  const claudeFile = path.join(dir, id, "SKILL.md");
  if (existsSync(claudeFile)) {
    try {
      const content = readFileSync(claudeFile, "utf8");
      return { ...parseSkill(id, content, source), content };
    } catch { /* fall through */ }
  }

  // Flat .md
  const flatFile = path.join(dir, `${id}.md`);
  if (existsSync(flatFile)) {
    try {
      const content = readFileSync(flatFile, "utf8");
      return { ...parseSkill(id, content, source), content };
    } catch { /* not found */ }
  }

  return null;
}

export function writeSkill(id: string, content: string): void {
  const dir = getSkillsDir();
  if (!dir) throw new Error("JARELA_SKILLS_DIR is not configured");
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
}

export function deleteSkill(id: string): boolean {
  const dir = getSkillsDir();
  if (!dir || !sanitizeId(id)) return false;

  const claudeFile = path.join(dir, id, "SKILL.md");
  if (existsSync(claudeFile)) {
    try {
      rmSync(claudeFile);
      try { rmdirSync(path.join(dir, id)); } catch { /* not empty */ }
      return true;
    } catch { /* fall through */ }
  }

  const flatFile = path.join(dir, `${id}.md`);
  if (existsSync(flatFile)) {
    try { rmSync(flatFile); return true; } catch { /* ignore */ }
  }

  return false;
}

function sanitizeId(id: string): boolean {
  return Boolean(id) && /^[\w-]+$/.test(id) && !id.includes("..") && !id.includes("/") && !id.includes("\\");
}
