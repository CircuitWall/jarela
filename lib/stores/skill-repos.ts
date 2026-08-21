// CRUD for the `skill_repos` table (ADR-0074). A repo is a directory the
// user has asked Jarela to scan for */SKILL.md (Claude-style) and *.md
// skill files, layered over the packaged built-ins.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

const now = () => new Date().toISOString();

export interface SkillRepoRow {
  id: string;
  path: string;
  label: string | null;
  writable: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

// Scan/override order: created_at ASC — a later repo's skill wins over an
// earlier repo's on id collision, so callers should apply rows in this order.
export function listSkillRepos(): SkillRepoRow[] {
  return getDb()
    .prepare("SELECT * FROM skill_repos ORDER BY created_at ASC")
    .all() as unknown as SkillRepoRow[];
}

export function listEnabledSkillRepos(): SkillRepoRow[] {
  return getDb()
    .prepare("SELECT * FROM skill_repos WHERE enabled=1 ORDER BY created_at ASC")
    .all() as unknown as SkillRepoRow[];
}

export function getSkillRepo(id: string): SkillRepoRow | null {
  const row = getDb().prepare("SELECT * FROM skill_repos WHERE id=?").get(id);
  return (row as SkillRepoRow | undefined) ?? null;
}

export function getSkillRepoByPath(path: string): SkillRepoRow | null {
  const row = getDb().prepare("SELECT * FROM skill_repos WHERE path=?").get(path);
  return (row as SkillRepoRow | undefined) ?? null;
}

// At most one repo may be writable at a time — write_skill/delete_skill
// target it. Undefined = "leave as-is" for updateSkillRepo; false clears it.
export function getWritableSkillRepo(): SkillRepoRow | null {
  const row = getDb().prepare("SELECT * FROM skill_repos WHERE writable=1").get();
  return (row as SkillRepoRow | undefined) ?? null;
}

// The first repo added becomes writable by default so a fresh setup has
// somewhere to write to without an extra API call.
export function createSkillRepo(input: {
  path: string;
  label?: string | null;
  writable?: boolean;
}): SkillRepoRow {
  const id = randomUUID();
  const t = now();
  const makeWritable = input.writable ?? (getWritableSkillRepo() === null);
  const db = getDb();
  if (makeWritable) {
    db.prepare("UPDATE skill_repos SET writable=0, updated_at=? WHERE writable=1").run(t);
  }
  db.prepare(
    `INSERT INTO skill_repos (id, path, label, writable, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, input.path, input.label ?? null, makeWritable ? 1 : 0, t, t);
  return getSkillRepo(id)!;
}

export function updateSkillRepo(
  id: string,
  patch: { label?: string | null; enabled?: boolean; writable?: boolean },
): SkillRepoRow | null {
  const existing = getSkillRepo(id);
  if (!existing) return null;
  const t = now();
  const db = getDb();
  if (patch.writable) {
    db.prepare("UPDATE skill_repos SET writable=0, updated_at=? WHERE writable=1 AND id<>?").run(t, id);
  }
  db.prepare("UPDATE skill_repos SET label=?, enabled=?, writable=?, updated_at=? WHERE id=?").run(
    patch.label === undefined ? existing.label : patch.label,
    patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
    patch.writable === undefined ? existing.writable : patch.writable ? 1 : 0,
    t,
    id,
  );
  return getSkillRepo(id);
}

export function deleteSkillRepo(id: string): boolean {
  return (getDb().prepare("DELETE FROM skill_repos WHERE id=?").run(id) as { changes: number }).changes > 0;
}
