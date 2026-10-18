import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

// Synthetic, memory-only data: never opens the user's database.
const db = new DatabaseSync(":memory:");
try {
  db.exec(`
    CREATE TABLE messages(msg_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
      content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX idx_messages_thread_id ON messages(thread_id, created_at);
    CREATE TABLE threads(thread_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
      updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_threads_agent_id ON threads(agent_id);
    CREATE TABLE message_usage(message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL, input_tokens INTEGER NOT NULL);
    CREATE INDEX idx_message_usage_created_at ON message_usage(created_at);
    CREATE TABLE memory_store(namespace TEXT NOT NULL, key TEXT NOT NULL,
      value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(namespace,key));
    CREATE TABLE message_embedding_jobs(message_id TEXT PRIMARY KEY, state TEXT NOT NULL,
      available_at_ms INTEGER NOT NULL, lease_until_ms INTEGER);
    CREATE INDEX idx_message_embedding_jobs_due
      ON message_embedding_jobs(state,available_at_ms,lease_until_ms);
    BEGIN;
  `);
  const messageInsert = db.prepare("INSERT INTO messages VALUES (?,?,?,?)");
  const threadInsert = db.prepare("INSERT INTO threads VALUES (?,?,?)");
  const usageInsert = db.prepare("INSERT INTO message_usage VALUES (?,?,?,?)");
  const memoryInsert = db.prepare("INSERT INTO memory_store VALUES (?,?,?,?)");
  const jobInsert = db.prepare("INSERT INTO message_embedding_jobs VALUES (?,?,?,?)");
  const content = "synthetic ".repeat(25);
  for (let i = 0; i < 40_000; i++) {
    const timestamp = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
    messageInsert.run(`m${i}`, `t${i % 8}`, content, timestamp);
    usageInsert.run(`m${i}`, `t${i % 10_000}`, timestamp, 100);
    memoryInsert.run(`ns${i % 8}`, `key${i}`, content, timestamp);
    jobInsert.run(`m${i}`, i % 2 === 0 ? "pending" : "processing", 1000 + i, 2000 + i);
  }
  for (let i = 0; i < 10_000; i++) {
    threadInsert.run(`t${i}`, `a${i}`, new Date(1_700_000_000_000 + i).toISOString());
  }
  db.exec("COMMIT");
  const cases = [
    {
      name: "latest message page",
      sql: "SELECT rowid AS seq, msg_id, content FROM messages WHERE thread_id=? ORDER BY rowid DESC LIMIT ?",
      args: ["t1", 51],
    },
    {
      name: "older message page",
      sql: "SELECT rowid AS seq, msg_id, content FROM messages WHERE thread_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?",
      args: ["t1", 20_000, 51],
    },
    {
      name: "dashboard date window",
      sql: "SELECT content FROM messages WHERE created_at>=? ORDER BY created_at ASC",
      args: ["2026-01-28T00:00:00.000Z"],
    },
    {
      name: "agent thread list",
      sql: "SELECT * FROM threads WHERE agent_id=? ORDER BY updated_at DESC LIMIT ?",
      args: ["a1", 50],
    },
    {
      name: "global thread list",
      sql: "SELECT * FROM threads ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      args: [50, 0],
    },
    {
      name: "latest usage for thread",
      sql: "SELECT * FROM message_usage WHERE thread_id=? ORDER BY created_at DESC LIMIT 1",
      args: ["t1"],
    },
    {
      name: "namespace memory list",
      sql: "SELECT namespace,key,value FROM memory_store WHERE namespace=? ORDER BY updated_at DESC LIMIT ?",
      args: ["ns1", 50],
    },
    {
      name: "global memory list",
      sql: "SELECT namespace,key,value FROM memory_store ORDER BY updated_at DESC LIMIT ?",
      args: [50],
    },
    {
      name: "embedding next wakeup",
      sql: `SELECT MIN(CASE WHEN state='pending' THEN available_at_ms ELSE lease_until_ms END) AS next_at_ms
        FROM message_embedding_jobs WHERE state IN ('pending','processing')`,
      afterSql: `SELECT MIN(next_at_ms) AS next_at_ms FROM (
        SELECT MIN(available_at_ms) AS next_at_ms FROM message_embedding_jobs WHERE state='pending'
        UNION ALL
        SELECT MIN(lease_until_ms) AS next_at_ms FROM message_embedding_jobs WHERE state='processing'
      )`,
      args: [],
    },
  ];
  function measure(test) {
    const statement = db.prepare(test.sql);
    const rows = statement.all(...test.args);
    for (let i = 0; i < 5; i++) statement.all(...test.args);
    const timings = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      statement.all(...test.args);
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${test.sql}`).all(...test.args)
      .map((row) => row.detail);
    return { rows, medianMs: timings[Math.floor(timings.length / 2)], plan };
  }
  const before = cases.map(measure);
  db.exec(`
    CREATE INDEX idx_messages_thread_seq ON messages(thread_id);
    CREATE INDEX idx_messages_created_at ON messages(created_at);
    CREATE INDEX idx_threads_updated ON threads(updated_at DESC);
    CREATE INDEX idx_message_usage_thread_created ON message_usage(thread_id,created_at DESC);
    CREATE INDEX idx_memory_namespace_updated ON memory_store(namespace,updated_at DESC);
    CREATE INDEX idx_memory_updated ON memory_store(updated_at DESC);
    CREATE INDEX idx_message_embedding_jobs_lease ON message_embedding_jobs(state,lease_until_ms);
  `);
  const after = cases.map((test) => measure({ ...test, sql: test.afterSql ?? test.sql }));
  const results = cases.map((test, i) => {
    assert.deepEqual(after[i].rows, before[i].rows, `${test.name}: output changed`);
    assert.ok(after[i].plan.every((line) => !line.includes("USE TEMP B-TREE")),
      `${test.name}: temporary sort remains`);
    return {
      query: test.name,
      rows: after[i].rows.length,
      beforeMedianMs: Number(before[i].medianMs.toFixed(3)),
      afterMedianMs: Number(after[i].medianMs.toFixed(3)),
      speedup: Number((before[i].medianMs / after[i].medianMs).toFixed(2)),
      plan: after[i].plan,
    };
  });
  console.log(JSON.stringify({
    messages: 40_000, threads: 10_000, usageSnapshots: 40_000,
    memoryRows: 40_000, activeEmbeddingJobs: 40_000, results,
  }, null, 2));
} finally {
  db.close();
}
