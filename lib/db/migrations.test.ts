import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-cred-migrate-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getDb } = await import("./index");
const { runMigrations } = await import("./migrations");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("responsive transcript indexes (ADR-0103)", () => {
  it("keeps existing indexes when migrations have already run", async () => {
    const db = getDb();
    const names = [
      "idx_messages_thread_seq", "idx_messages_created_at",
      "idx_threads_updated", "idx_message_usage_thread_created",
      "idx_memory_namespace_updated", "idx_memory_updated",
      "idx_runtime_operations_thread_state", "idx_signal_events_thread",
      "idx_signal_events_operation", "idx_signal_deliveries_lease",
      "idx_background_results_expiry", "idx_message_embedding_jobs_lease",
    ];
    runMigrations(db);
    runMigrations(db);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()
      .map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(names));
  });
  it.each([
    ["SELECT rowid, msg_id, content FROM messages WHERE thread_id=? ORDER BY rowid DESC LIMIT ?", ["thread", 51]],
    ["SELECT rowid, msg_id, content FROM messages WHERE thread_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?", ["thread", 100, 51]],
    ["SELECT rowid, msg_id, content FROM messages WHERE thread_id=? AND rowid>? ORDER BY rowid ASC LIMIT ?", ["thread", 100, 50]],
    ["SELECT content FROM messages WHERE created_at>=? ORDER BY created_at ASC", ["2026-10-01"]],
    ["SELECT * FROM threads WHERE agent_id=? ORDER BY updated_at DESC LIMIT ?", ["agent", 50]],
    ["SELECT * FROM threads ORDER BY updated_at DESC LIMIT ? OFFSET ?", [50, 0]],
  ])("uses ordered indexes for %s", (query, params) => {
    const plan = getDb().prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params)
      .map((row) => String(row.detail)).join("; ");
    expect(plan).not.toMatch(/USE TEMP B-TREE|SCAN (?:messages|threads)(?! USING INDEX)/);
    expect(plan).toMatch(/USING INDEX/);
  });

  it.each([
    ["SELECT * FROM message_usage WHERE thread_id=? ORDER BY created_at DESC LIMIT 1", ["thread"], "idx_message_usage_thread_created"],
    ["SELECT namespace,key,value FROM memory_store WHERE namespace=? ORDER BY updated_at DESC LIMIT ?", ["facts", 50], "idx_memory_namespace_updated"],
    ["SELECT namespace,key,value FROM memory_store ORDER BY updated_at DESC LIMIT ?", [50], "idx_memory_updated"],
    ["SELECT rowid FROM runtime_operations WHERE thread_id=? AND state='accepted'", ["thread"], "idx_runtime_operations_thread_state"],
    ["SELECT rowid FROM signal_events WHERE thread_id=?", ["thread"], "idx_signal_events_thread"],
    ["SELECT rowid FROM signal_events WHERE operation_id=?", ["operation"], "idx_signal_events_operation"],
    ["SELECT key FROM background_tool_results WHERE expires_at<=?", [1000], "idx_background_results_expiry"],
    ["SELECT event_id FROM signal_deliveries WHERE state='leased' AND lease_until<=?", [1000], "idx_signal_deliveries_lease"],
    ["SELECT message_id FROM message_embedding_jobs WHERE state='processing' AND lease_until_ms<=?", [1000], "idx_message_embedding_jobs_lease"],
  ])("indexes secondary lookup %s", (query, params, index) => {
    const plan = getDb().prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params)
      .map((row) => String(row.detail)).join("; ");
    expect(plan).not.toMatch(/USE TEMP B-TREE/);
    expect(plan).toContain(index);
    if (!query.includes("FROM memory_store ORDER BY")) expect(plan).toContain("SEARCH");
  });

  it("reuses the unique agent index instead of adding a redundant ordering index", () => {
    const indexes = getDb().prepare("PRAGMA index_list(threads)").all();
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idx_threads_agent_id", unique: 1 }),
    ]));
    expect(indexes.some((row) => row.name === "idx_threads_agent_updated")).toBe(false);
  });
});
