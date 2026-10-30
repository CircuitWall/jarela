import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableWorkflowRunStore, migrateWorkflowRuns, WORKFLOW_RETENTION_MS } from "./workflow-runs";

vi.mock("@/lib/crypto/master-key", () => ({ getMasterKey: () => Buffer.alloc(32, 7) }));
const databases: DatabaseSync[] = [];
const paths: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
  for (const path of paths.splice(0)) for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});
function db(path = ":memory:") {
  const value = new DatabaseSync(path);
  databases.push(value);
  value.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS agent_configs (id TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO agent_configs VALUES ('one'), ('two');`);
  return value;
}
const workspace = process.cwd();
const owner = JSON.stringify({ pid: process.pid, instanceId: randomUUID() });
const row = () => ({ id: randomUUID(), revision: "a".repeat(64), owner, state: '{"phase":"ready","secret":"synthetic private input"}' });

describe("production workflow storage", () => {
  it("migrates once, rejects future versions, and never adopts inert plaintext rows", () => {
    const database = db();
    database.exec("CREATE TABLE bounded_workflow_runs (state TEXT); INSERT INTO bounded_workflow_runs VALUES ('legacy');");
    migrateWorkflowRuns(database);
    migrateWorkflowRuns(database);
    expect(database.prepare("SELECT version FROM workflow_schema").get()?.version).toBe(1);
    expect(new DurableWorkflowRunStore(database, "one").list()).toEqual([]);
    const future = new DatabaseSync(":memory:");
    databases.push(future);
    future.exec("CREATE TABLE workflow_schema(singleton INTEGER PRIMARY KEY,version INTEGER); INSERT INTO workflow_schema VALUES(1,2)");
    expect(() => migrateWorkflowRuns(future)).toThrow(/Unsupported/);
    expect(future.prepare("SELECT version FROM workflow_schema").get()?.version).toBe(2);
  });

  it("requires enforced cascading agent ownership and refuses pre-release tables without it", () => {
    const disabled = db();
    disabled.exec("PRAGMA foreign_keys = OFF");
    expect(() => migrateWorkflowRuns(disabled)).toThrow(/foreign key/);
    expect(disabled.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='durable_workflow_runs'").get()?.count).toBe(0);
    const unowned = db();
    unowned.exec(`CREATE TABLE workflow_schema(singleton INTEGER PRIMARY KEY, version INTEGER);
      INSERT INTO workflow_schema VALUES(1,1);
      CREATE TABLE durable_workflow_runs(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL);`);
    expect(() => migrateWorkflowRuns(unowned)).toThrow(/Unsupported/);
    const cached = db();
    migrateWorkflowRuns(cached);
    cached.exec("PRAGMA foreign_keys = OFF");
    expect(() => new DurableWorkflowRunStore(cached, "one")).toThrow(/foreign key/);
  });

  it("cascades agent deletion so a recreated agent ID cannot resurrect runs or retain capacity", () => {
    const store = new DurableWorkflowRunStore(db(), "one", workspace);
    const deleted = new DurableWorkflowRunStore(store.database, "two", workspace);
    const prior = deleted.create(row());
    const insert = store.database.prepare(`INSERT INTO durable_workflow_runs
      SELECT ?,agent_id,revision,version,owner,payload,phase,created_at,updated_at,expires_at
      FROM durable_workflow_runs WHERE id=?`);
    for (let index = 1; index < 1000; index++) insert.run(randomUUID(), prior.id);
    expect(() => store.create(row())).toThrow(/capacity/);
    store.database.exec("DELETE FROM agent_configs WHERE id='two'");
    expect(store.database.prepare("SELECT count(*) AS count FROM durable_workflow_runs").get()?.count).toBe(0);
    expect(() => deleted.save(prior, '{"phase":"completed"}')).toThrow(/not found/);
    store.database.exec("INSERT INTO agent_configs VALUES ('two')");
    const recreated = new DurableWorkflowRunStore(store.database, "two", workspace);
    expect(recreated.list()).toEqual([]);
    expect(() => recreated.get(prior.id)).toThrow(/not found/);
    expect(store.create(row())).toBeDefined();
    expect(() => new DurableWorkflowRunStore(store.database, "missing", workspace).create(row())).toThrow(/FOREIGN KEY/);
  });

  it("persists envelope-encrypted state and workspace across a real database reopen", () => {
    const path = resolve(`.workflow-store-${randomUUID()}.sqlite`);
    paths.push(path);
    const database = db(path);
    const store = new DurableWorkflowRunStore(database, "one", workspace);
    const created = store.create(row());
    const stored = database.prepare("SELECT payload FROM durable_workflow_runs").get()!.payload as string;
    expect(stored).toMatch(/^enc:v1:/);
    expect(stored).not.toContain("synthetic private input");
    expect(stored).not.toContain(workspace);
    database.close();
    const reopened = new DurableWorkflowRunStore(db(path), "one");
    expect(reopened.get(created.id).state).toBe(created.state);
    expect(reopened.getWorkspace(created.id)).toBe(workspace);
    expect(() => new DurableWorkflowRunStore(reopened.database, "two").get(created.id)).toThrow(/not found/);
  });

  it("checks CAS, rejects ciphertext swaps, and bounds UTF-8 state", () => {
    const store = new DurableWorkflowRunStore(db(), "one", workspace);
    const created = store.create(row());
    store.save(created, '{"phase":"waiting"}');
    expect(() => store.save(created, '{"phase":"completed"}')).toThrow(/changed/);
    expect(() => store.create({ ...row(), state: `{"phase":"ready","value":"${"🙂".repeat(140000)}"}` })).toThrow();
    const other = store.create(row());
    store.database.prepare("UPDATE durable_workflow_runs SET payload=(SELECT payload FROM durable_workflow_runs WHERE id=?) WHERE id=?")
      .run(other.id, created.id);
    expect(() => store.get(created.id)).toThrow(/identity/);
    store.database.prepare("UPDATE durable_workflow_runs SET payload=? WHERE id=?").run('{"plaintext":true}', other.id);
    expect(() => store.get(other.id)).toThrow(/non-encrypted/);
  });

  it("retains waiting/uncertain rows and deletes terminal rows only in bounded batches", () => {
    let now = 1000;
    const store = new DurableWorkflowRunStore(db(), "one", workspace, () => now);
    const waiting = store.create({ ...row(), state: '{"phase":"waiting"}' });
    const uncertain = store.create({ ...row(), state: '{"phase":"uncertain"}' });
    for (let index = 0; index < 3; index++) store.create({ ...row(), state: '{"phase":"completed"}' });
    now += WORKFLOW_RETENTION_MS + 1;
    expect(store.cleanup(2)).toBe(2);
    expect(store.cleanup(2)).toBe(1);
    expect(store.get(waiting.id)).toBeDefined();
    expect(store.get(uncertain.id)).toBeDefined();
    expect(() => store.cleanup(101)).toThrow();
  });

  it("bounds active storage capacity and pages only the owning agent", () => {
    const store = new DurableWorkflowRunStore(db(), "one", workspace);
    const created = store.create(row());
    const insert = store.database.prepare(`INSERT INTO durable_workflow_runs
      SELECT ?,agent_id,revision,version,owner,payload,phase,created_at,updated_at,expires_at
      FROM durable_workflow_runs WHERE id=?`);
    for (let index = 1; index < 1000; index++) insert.run(randomUUID(), created.id);
    expect(() => store.create(row())).toThrow(/capacity/);
    expect(new DurableWorkflowRunStore(store.database, "two").list()).toEqual([]);
    expect(() => store.list(101)).toThrow();
  });
});
