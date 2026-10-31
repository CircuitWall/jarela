import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-skill-repos-route-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { closeDb, getDb } = await import("@/lib/db");
const { createSkillRepo } = await import("@/lib/stores/skill-repos");
const { GET, POST } = await import("./route");
const { GET: getItem, PATCH } = await import("./[id]/route");

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

  it("keeps the create, collection and item shapes aligned without changing envelopes or caching", async () => {
    const response = await POST(new NextRequest("http://localhost/api/v1/skills/repos", {
      method: "POST", body: JSON.stringify({ path: tmpRoot, label: "Synthetic", writable: false }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toEqual({
      id: expect.any(String), path: tmpRoot, label: "Synthetic", writable: false, enabled: true,
      created_at: expect.any(String), updated_at: expect.any(String),
    });
    const params = { params: Promise.resolve({ id: created.id }) };
    const req = new NextRequest(`http://localhost/api/v1/skills/repos/${created.id}`);
    const item = await getItem(req, params);
    expect(item.status).toBe(200);
    await expect(item.json()).resolves.toEqual(created);
    const list = GET();
    expect(list.headers.get("Cache-Control")).toBe("no-store");
    await expect(list.json()).resolves.toEqual({ repos: [created] });

    const patch = await PATCH(new NextRequest(req.url, {
      method: "PATCH", body: JSON.stringify({ label: null, enabled: false, writable: true }),
      headers: { "Content-Type": "application/json" },
    }), params);
    expect(patch.status).toBe(200);
    const updated = await patch.json();
    expect(updated).toEqual({ ...created, label: null, enabled: false, writable: true, updated_at: expect.any(String) });
    await expect((await getItem(req, params)).json()).resolves.toEqual(updated);
    await expect(GET().json()).resolves.toEqual({ repos: [updated] });
  });
});