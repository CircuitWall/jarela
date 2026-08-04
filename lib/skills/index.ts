// Skills loader — reads SKILL.md files from JARELA_SKILLS_DIR.
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
}

export interface SkillWithContent extends Skill {
  content: string;
}

export function getSkillsDir(): string {
  return getConfig().skillsDir;
}

function parseSkill(id: string, content: string): Skill {
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

  return { id, name, description: descParts.join(" ").slice(0, 200) };
}

export function listSkills(): Skill[] {
  const dir = getSkillsDir();
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
        skills.push(parseSkill(entry.name, content));
      } catch { /* skip unreadable */ }
    } else if (entry.name.endsWith(".md")) {
      const id = entry.name.slice(0, -3);
      try {
        const content = readFileSync(path.join(dir, entry.name), "utf8");
        skills.push(parseSkill(id, content));
      } catch { /* skip unreadable */ }
    }
  }

  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

export function getSkill(id: string): SkillWithContent | null {
  const dir = getSkillsDir();
  if (!dir || !sanitizeId(id)) return null;

  // Claude-style first
  const claudeFile = path.join(dir, id, "SKILL.md");
  if (existsSync(claudeFile)) {
    try {
      const content = readFileSync(claudeFile, "utf8");
      return { ...parseSkill(id, content), content };
    } catch { /* fall through */ }
  }

  // Flat .md
  const flatFile = path.join(dir, `${id}.md`);
  if (existsSync(flatFile)) {
    try {
      const content = readFileSync(flatFile, "utf8");
      return { ...parseSkill(id, content), content };
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
