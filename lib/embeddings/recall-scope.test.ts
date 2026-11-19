import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarela-recall-scope-"));
process.env.JARELA_DB_DIR = root;

const { getDb, closeDb } = await import("@/lib/db");
const { closeReadPool } = await import("@/lib/db/read-pool");
const { loadMessageCandidates } = await import("./index");

afterAll(async () => {
  await closeReadPool();
  closeDb();
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

afterEach(() => {
  getDb().exec("DELETE FROM messages; DELETE FROM threads;");
});

function seed(threadId: string, msgId: string, content: string, daysAgo: number) {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO threads (thread_id, agent_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run(threadId, "agent", "2026-01-01", "2026-01-01");
  const created = new Date(Date.now() - daysAgo * 24 * 60 * 60_000).toISOString();
  db.prepare("INSERT INTO messages (msg_id, thread_id, role, content, created_at, transcript_status, embedding) VALUES (?,?,?,?,?,'completed','[1,0]')")
    .run(msgId, threadId, "user", content, created);
}

describe("targeted recall candidates (ADR-0119)", () => {
  it("scopes to the current thread plus the recency window", async () => {
    seed("thread-current", "m-current-old", "ancient baseline note", 120);
    seed("thread-other", "m-other-old", "unrelated older conversation", 120);
    seed("thread-other", "m-other-new", "recent other conversation", 2);

    const scoped = await loadMessageCandidates("nothing lexical here", { threadId: "thread-current" });
    const ids = scoped.map((row) => row.msg_id).sort();

    // Own thread survives any age; another thread only inside the window.
    expect(ids).toContain("m-current-old");
    expect(ids).toContain("m-other-new");
    expect(ids).not.toContain("m-other-old");
  });

  it("adds full-text matches from outside the window", async () => {
    seed("thread-current", "m-current", "today", 0);
    seed("thread-elsewhere", "m-old-fts", "the quetzalcoatl rollout plan", 400);

    const scoped = await loadMessageCandidates("quetzalcoatl", { threadId: "thread-current" });

    expect(scoped.map((row) => row.msg_id)).toContain("m-old-fts");
  });

  it("deep mode reaches every thread regardless of age", async () => {
    seed("thread-a", "m-a", "old a", 400);
    seed("thread-b", "m-b", "old b", 400);

    const deep = await loadMessageCandidates("nothing lexical", { deep: true });

    expect(deep.map((row) => row.msg_id).sort()).toEqual(["m-a", "m-b"]);
  });

  it("ignores unembedded rows, drafts, and malformed FTS input", async () => {
    const db = getDb();
    seed("thread-current", "m-ok", "fine", 0);
    db.prepare("INSERT INTO messages (msg_id, thread_id, role, content, created_at, transcript_status) VALUES ('m-draft','thread-current','assistant','streaming',?, 'in_progress')")
      .run(new Date().toISOString());
    db.prepare("INSERT INTO messages (msg_id, thread_id, role, content, created_at, transcript_status) VALUES ('m-no-vector','thread-current','user','no vector',?, 'completed')")
      .run(new Date().toISOString());

    const rows = await loadMessageCandidates('"unbalanced ( FTS', { threadId: "thread-current" });

    expect(rows.map((row) => row.msg_id)).toEqual(["m-ok"]);
  });
});
