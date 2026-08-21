import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-skill-repos-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getDb } = await import("@/lib/db");
const {
  createSkillRepo,
  listSkillRepos,
  listEnabledSkillRepos,
  getSkillRepo,
  getSkillRepoByPath,
  getWritableSkillRepo,
  updateSkillRepo,
  deleteSkillRepo,
} = await import("./skill-repos");

function wipe(): void {
  getDb().exec("DELETE FROM skill_repos");
}

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

beforeEach(() => { wipe(); });

describe("createSkillRepo", () => {
  it("makes the first repo added writable by default", () => {
    const row = createSkillRepo({ path: "/repo-one" });
    expect(row.writable).toBe(1);
    expect(getWritableSkillRepo()?.id).toBe(row.id);
  });

  it("does not make a later repo writable by default", () => {
    createSkillRepo({ path: "/repo-one" });
    const second = createSkillRepo({ path: "/repo-two" });
    expect(second.writable).toBe(0);
  });

  it("honours an explicit writable:true and clears the previous writable repo", () => {
    const first = createSkillRepo({ path: "/repo-one" });
    const second = createSkillRepo({ path: "/repo-two", writable: true });
    expect(getSkillRepo(first.id)?.writable).toBe(0);
    expect(getWritableSkillRepo()?.id).toBe(second.id);
  });

  it("honours an explicit writable:false on the first repo, leaving no repo writable", () => {
    const row = createSkillRepo({ path: "/repo-one", writable: false });
    expect(row.writable).toBe(0);
    expect(getWritableSkillRepo()).toBeNull();
  });

  it("stores a label and defaults enabled to true", () => {
    const row = createSkillRepo({ path: "/repo-one", label: "Team shared" });
    expect(row.label).toBe("Team shared");
    expect(row.enabled).toBe(1);
  });
});

describe("listSkillRepos / listEnabledSkillRepos", () => {
  it("lists all repos in created_at order", () => {
    createSkillRepo({ path: "/repo-one" });
    createSkillRepo({ path: "/repo-two" });
    expect(listSkillRepos().map((r) => r.path)).toEqual(["/repo-one", "/repo-two"]);
  });

  it("excludes disabled repos from listEnabledSkillRepos", () => {
    createSkillRepo({ path: "/repo-one" });
    const second = createSkillRepo({ path: "/repo-two" });
    updateSkillRepo(second.id, { enabled: false });
    expect(listEnabledSkillRepos().map((r) => r.path)).toEqual(["/repo-one"]);
    expect(listSkillRepos().map((r) => r.path)).toEqual(["/repo-one", "/repo-two"]);
  });
});

describe("getSkillRepoByPath", () => {
  it("finds a repo by exact path", () => {
    createSkillRepo({ path: "/repo-one" });
    expect(getSkillRepoByPath("/repo-one")?.path).toBe("/repo-one");
    expect(getSkillRepoByPath("/nope")).toBeNull();
  });
});

describe("updateSkillRepo", () => {
  it("returns null for an unknown id", () => {
    expect(updateSkillRepo("nope", { enabled: false })).toBeNull();
  });

  it("moves the writable flag when patched onto a different repo", () => {
    const first = createSkillRepo({ path: "/repo-one" });
    const second = createSkillRepo({ path: "/repo-two" });
    updateSkillRepo(second.id, { writable: true });
    expect(getSkillRepo(first.id)?.writable).toBe(0);
    expect(getSkillRepo(second.id)?.writable).toBe(1);
  });

  it("leaves other fields untouched when only one field is patched", () => {
    const row = createSkillRepo({ path: "/repo-one", label: "Original" });
    const updated = updateSkillRepo(row.id, { enabled: false });
    expect(updated?.label).toBe("Original");
    expect(updated?.enabled).toBe(0);
  });
});

describe("deleteSkillRepo", () => {
  it("deletes an existing repo and returns true", () => {
    const row = createSkillRepo({ path: "/repo-one" });
    expect(deleteSkillRepo(row.id)).toBe(true);
    expect(getSkillRepo(row.id)).toBeNull();
  });

  it("returns false for an unknown id", () => {
    expect(deleteSkillRepo("nope")).toBe(false);
  });
});
