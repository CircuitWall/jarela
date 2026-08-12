import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-claude-delegate-sessions-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getSession, rememberSession } = await import("./claude-delegate-sessions");
const { getDb } = await import("@/lib/db");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("claude-delegate-sessions store", () => {
  it("returns null for a project that has never delegated", () => {
    expect(getSession("/tmp/never-seen")).toBeNull();
  });

  it("round-trips a session id for a project key", () => {
    rememberSession("/tmp/proj-a", "session-123");
    expect(getSession("/tmp/proj-a")).toBe("session-123");
  });

  it("upserts — a second remember for the same key overwrites the session id", () => {
    rememberSession("/tmp/proj-b", "session-old");
    rememberSession("/tmp/proj-b", "session-new");
    expect(getSession("/tmp/proj-b")).toBe("session-new");
  });

  it("keeps separate projects independent", () => {
    rememberSession("/tmp/proj-c", "session-c");
    rememberSession("/tmp/proj-c:feature-x", "session-c-feature-x");
    expect(getSession("/tmp/proj-c")).toBe("session-c");
    expect(getSession("/tmp/proj-c:feature-x")).toBe("session-c-feature-x");
  });

  it("treats a session older than the TTL as expired", () => {
    rememberSession("/tmp/proj-stale", "session-stale");
    const staleTimestamp = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    getDb()
      .prepare("UPDATE claude_delegate_sessions SET updated_at=? WHERE project_key=?")
      .run(staleTimestamp, "/tmp/proj-stale");
    expect(getSession("/tmp/proj-stale")).toBeNull();
  });

  it("prunes expired rows as a side effect of a subsequent remember", () => {
    rememberSession("/tmp/proj-old", "session-old");
    const staleTimestamp = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    getDb()
      .prepare("UPDATE claude_delegate_sessions SET updated_at=? WHERE project_key=?")
      .run(staleTimestamp, "/tmp/proj-old");

    rememberSession("/tmp/proj-trigger-prune", "session-trigger");

    const row = getDb()
      .prepare("SELECT project_key FROM claude_delegate_sessions WHERE project_key=?")
      .get("/tmp/proj-old");
    expect(row).toBeUndefined();
  });
});
