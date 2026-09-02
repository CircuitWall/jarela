import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-skills-cache-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getDb } = await import("@/lib/db");
const { listSkills, writeSkill, deleteSkill, invalidateSkillsCache } = await import("./index");
const { createSkillRepo } = await import("@/lib/stores/skill-repos");

const repoDir = join(tmpRoot, "repo");
mkdirSync(repoDir, { recursive: true });
getDb().exec("DELETE FROM skill_repos");
createSkillRepo({ path: repoDir });

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

function skillBody(id: string, description: string) {
  return `# ${id}\n${description}\n`;
}

// Cache mechanics (ttl, keying, invalidate) are covered once in
// lib/cache/keyed-cache.test.ts. These assert only what is specific to
// skills: that every mutation path stays visible to the next read.
describe("skills cache", () => {
  beforeEach(() => invalidateSkillsCache());

  it("shows a skill written through writeSkill on the very next read", () => {
    listSkills(); // prime the cache so a stale hit would be possible
    writeSkill("cache-probe", skillBody("cache-probe", "written at runtime"));

    expect(listSkills().map((s) => s.id)).toContain("cache-probe");
  });

  it("drops a skill removed through deleteSkill immediately", () => {
    writeSkill("cache-doomed", skillBody("cache-doomed", "about to go"));
    expect(listSkills().map((s) => s.id)).toContain("cache-doomed");

    deleteSkill("cache-doomed");

    expect(listSkills().map((s) => s.id)).not.toContain("cache-doomed");
  });

  it("reflects an in-place edit through writeSkill without waiting for the ttl", () => {
    writeSkill("cache-edited", skillBody("cache-edited", "first description"));
    expect(listSkills().find((s) => s.id === "cache-edited")?.description).toBe("first description");

    writeSkill("cache-edited", skillBody("cache-edited", "second description"));

    expect(listSkills().find((s) => s.id === "cache-edited")?.description).toBe("second description");
  });

  it("re-scans when the set of enabled repos changes", () => {
    const extra = join(tmpRoot, "repo-two");
    mkdirSync(join(extra, "cache-second-repo"), { recursive: true });
    writeFileSync(
      join(extra, "cache-second-repo", "SKILL.md"),
      skillBody("cache-second-repo", "from a repo added after the first scan"),
      "utf8",
    );

    listSkills(); // cache the pre-change repo set
    createSkillRepo({ path: extra });

    // No file in the original repo changed, so only the repo set can signal this.
    expect(listSkills().map((s) => s.id)).toContain("cache-second-repo");
  });
});
