import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-codex-delegate-sessions-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getSession, rememberSession } = await import("./codex-delegate-sessions");
const { getDb } = await import("@/lib/db");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("codex-delegate-sessions store", () => {
  it("keeps a distinct resumable session per project key", () => {
    rememberSession("/tmp/project", "thread-one");
    rememberSession("/tmp/project:feature", "thread-two");

    expect(getSession("/tmp/project")).toBe("thread-one");
    expect(getSession("/tmp/project:feature")).toBe("thread-two");
  });

  it("expires stale sessions", () => {
    rememberSession("/tmp/stale", "thread-stale");
    getDb().prepare("UPDATE codex_delegate_sessions SET updated_at=? WHERE project_key=?")
      .run(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), "/tmp/stale");

    expect(getSession("/tmp/stale")).toBeNull();
  });
});