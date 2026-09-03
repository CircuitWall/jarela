import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-skill-repos-route-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { closeDb, getDb } = await import("@/lib/db");
const { createSkillRepo } = await import("@/lib/stores/skill-repos");
const { GET } = await import("./route");

beforeEach(() => {
  getDb().exec("DELETE FROM skill_repos");
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/v1/skills/repos", () => {
  it("is not cached so UI refetches observe repo mutations immediately", async () => {
    createSkillRepo({ path: "/repo-one" });

    const res = GET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toMatchObject({
      repos: [{ path: "/repo-one", writable: true, enabled: true }],
    });
  });
});