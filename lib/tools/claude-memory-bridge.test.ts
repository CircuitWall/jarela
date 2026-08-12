import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-claude-memory-bridge-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const bridge = await import("./claude-memory-bridge");
const { listMemory, putMemory } = await import("@/lib/stores/memory");
const { getDb } = await import("@/lib/db");

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpRoot, "proj-"));
});

function memDir(cwd: string): string {
  return bridge.claudeProjectDir(cwd);
}

function setRowUpdatedAt(namespace: string, key: string, iso: string): void {
  getDb().prepare("UPDATE memory_store SET updated_at=? WHERE namespace=? AND key=?").run(iso, namespace, key);
}

describe("namespaceForCwd / claudeProjectDir", () => {
  it("derives a stable claude-sync:<hash> namespace from an absolute path", () => {
    const ns = bridge.namespaceForCwd(projectRoot);
    expect(ns).toMatch(/^claude-sync:[0-9a-f]{12}$/);
    expect(bridge.namespaceForCwd(projectRoot)).toBe(ns);
  });

  it("encodes the project path the same way Claude Code does", () => {
    const dir = memDir("/Users/example-user/workspace/example-project");
    expect(dir).toBe(join(tmpRoot, ".claude", "projects", "-Users-example-user-workspace-example-project", "memory"));
  });

  it("normalizes Windows drive paths into a Claude project directory", () => {
    const dir = memDir("C:\\Users\\andre\\workspace\\example-project");
    expect(dir).toBe(join(tmpRoot, ".claude", "projects", "-C--Users-andre-workspace-example-project", "memory"));
  });
});

describe("syncIn / syncOut namespace gate", () => {
  it("refuses a namespace outside claude-sync:*", () => {
    expect(() => bridge.syncIn(projectRoot, "other:ns")).toThrow(/claude-sync/);
    expect(() => bridge.syncOut(projectRoot, "other:ns")).toThrow(/claude-sync/);
  });
});

describe("syncIn", () => {
  it("writes a memory row as a Claude memory file with frontmatter and rebuilds the index", () => {
    const ns = bridge.namespaceForCwd(projectRoot);
    putMemory(ns, "team-conventions", {
      type: "project",
      description: "How this team ships code",
      body: "Trunk-based, squash merges.",
    });

    const r = bridge.syncIn(projectRoot, ns);
    expect(r.written).toEqual(["team-conventions"]);
    expect(r.skipped).toEqual([]);

    const filePath = join(memDir(projectRoot), "team-conventions.md");
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("name: team-conventions");
    expect(content).toContain("description: How this team ships code");
    expect(content).toContain("type: project");
    expect(content).toContain("Trunk-based, squash merges.");

    const index = readFileSync(join(memDir(projectRoot), "MEMORY.md"), "utf8");
    expect(index).toContain("[Team conventions](team-conventions.md) — How this team ships code");
  });

  it("skips writing when the on-disk file is newer than the row", () => {
    const ns = bridge.namespaceForCwd(projectRoot);
    putMemory(ns, "fact", { type: "user", description: "", body: "v1" });
    bridge.syncIn(projectRoot, ns);

    // File is now newer than the row it came from — bump the row's
    // updated_at back so the file "wins" on the next syncIn.
    setRowUpdatedAt(ns, "fact", "2020-01-01T00:00:00.000Z");
    const r = bridge.syncIn(projectRoot, ns);
    expect(r.skipped).toEqual([{ key: "fact", reason: "file-newer" }]);
    expect(r.written).toEqual([]);
  });
});

describe("syncOut", () => {
  it("returns an empty result when Claude has never written to this project", () => {
    const ns = bridge.namespaceForCwd(projectRoot);
    expect(bridge.syncOut(projectRoot, ns)).toEqual({ pushed: [], deleted: [], skipped: [], count: 0 });
  });

  it("pushes a Claude-authored memory file into the memory store", () => {
    const ns = bridge.namespaceForCwd(projectRoot);
    // Simulate Claude writing its own memory file directly (bypassing syncIn).
    const dir = memDir(projectRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "learned-fact.md"),
      "---\nname: learned-fact\ndescription: Something Claude learned\nmetadata:\n  type: feedback\n---\n\nAlways run tests before committing.\n",
    );

    const r = bridge.syncOut(projectRoot, ns);
    expect(r.pushed).toEqual(["learned-fact"]);

    const rows = listMemory(ns);
    expect(rows).toHaveLength(1);
    const value = JSON.parse(rows[0].value) as { type: string; description: string; body: string };
    expect(value.type).toBe("feedback");
    expect(value.description).toBe("Something Claude learned");
    expect(value.body).toBe("Always run tests before committing.");
  });

  it("skips pushing when the stored row is already newer than the file", () => {
    const ns = bridge.namespaceForCwd(projectRoot);
    const dir = memDir(projectRoot);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "fact.md");
    writeFileSync(filePath, "---\nname: fact\ndescription: \nmetadata:\n  type: user\n---\n\nold\n");
    // Backdate the file's mtime so the row (written "now") is newer.
    const past = new Date(Date.now() - 60_000);
    utimesSync(filePath, past, past);
    putMemory(ns, "fact", { type: "user", description: "", body: "already up to date" });

    const r = bridge.syncOut(projectRoot, ns);
    expect(r.skipped).toEqual([{ key: "fact", reason: "row-newer" }]);
    expect(r.pushed).toEqual([]);
  });

  it("deletes rows whose file disappeared since the paired syncIn", () => {
    const ns = bridge.namespaceForCwd(projectRoot);
    putMemory(ns, "will-be-deleted", { type: "user", description: "", body: "temp" });
    const { manifest } = bridge.syncIn(projectRoot, ns);
    expect(manifest.has("will-be-deleted")).toBe(true);

    // Claude deleted the file during its session.
    unlinkSync(join(memDir(projectRoot), "will-be-deleted.md"));

    const r = bridge.syncOut(projectRoot, ns, manifest);
    expect(r.deleted).toEqual(["will-be-deleted"]);
    expect(listMemory(ns).some((row) => row.key === "will-be-deleted")).toBe(false);
  });
});
