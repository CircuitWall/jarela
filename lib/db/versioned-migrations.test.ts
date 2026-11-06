import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDeferredDataMigrations, runMigrations, SUPPORTED_MIGRATION_IDS } from "./migrations";
import { getDb } from "./index";
import { decryptIfNeeded, encrypt } from "@/lib/crypto/envelope";
import packageJson from "../../package.json";

const releaseSchema = readFileSync(new URL("./fixtures/v3.0.0.sql", import.meta.url), "utf8");
const databases: DatabaseSync[] = [];

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("versioned database migrations", () => {
  it("retains migration IDs only within the supported major-version window", () => {
    const major = Number(packageJson.version.split(".")[0]);
    expect(Number.isSafeInteger(major)).toBe(true);
    expect(new Set(SUPPORTED_MIGRATION_IDS).size).toBe(SUPPORTED_MIGRATION_IDS.length);
    for (const id of SUPPORTED_MIGRATION_IDS) {
      const match = /^(\d+)\.\d+\.\d+-/.exec(id);
      expect(match, `invalid migration ID: ${id}`).not.toBeNull();
      const migrationMajor = Number(match?.[1]);
      expect(migrationMajor).toBeGreaterThanOrEqual(Math.max(3, major - 1));
      expect(migrationMajor).toBeLessThanOrEqual(major);
    }
  });

  it("initializes a fresh database and records the baseline", () => {
    const db = database();
    runMigrations(db);
    expect(db.prepare("SELECT id FROM jarela_migrations").all()).toEqual([{ id: "3.0.0-baseline" }]);
    expect(db.prepare("SELECT last_seq FROM message_seq_allocator WHERE id=1").get()).toEqual({ last_seq: 0 });
    expect(db.prepare("SELECT * FROM agent_configs").all()).toEqual([]);
  });

  it("creates the same schema as the 3.0 release fixture", () => {
    const fresh = database();
    const release = database();
    runMigrations(fresh);
    release.exec(releaseSchema);
    const schema = (db: DatabaseSync) => db.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != 'jarela_migrations' ORDER BY type, name",
    ).all();
    expect(schema(fresh)).toEqual(schema(release));
  });

  it("accepts a 3.0 database and preserves existing rows", () => {
    const db = database();
    db.exec(releaseSchema);
    db.prepare("INSERT INTO threads (thread_id, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("thread", "agent", "created", "updated");
    const prepare = vi.spyOn(db, "prepare");
    runMigrations(db);
    expect(prepare.mock.calls.filter(([sql]) => sql === "SELECT name FROM sqlite_schema WHERE type='index'")).toHaveLength(1);
    prepare.mockRestore();
    expect(db.prepare("SELECT thread_id, agent_id FROM threads").all()).toEqual([{ thread_id: "thread", agent_id: "agent" }]);
    expect(db.prepare("SELECT id FROM jarela_migrations").all()).toEqual([{ id: "3.0.0-baseline" }]);
  });

  it("does not rerun an applied baseline", () => {
    const db = database();
    runMigrations(db);
    db.exec("DROP INDEX idx_threads_updated");
    runMigrations(db);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='idx_threads_updated'").get()).toBeUndefined();
  });

  it("rejects an incomplete unmarked schema without modifying it", () => {
    const db = database();
    db.exec("CREATE TABLE threads (thread_id TEXT PRIMARY KEY)");
    expect(() => runMigrations(db)).toThrow(/does not match the Jarela 3.0 baseline/);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='jarela_migrations'").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='threads'").get()).toBeDefined();
  });

  it("rejects an unmarked database missing a baseline index", () => {
    const db = database();
    db.exec(releaseSchema);
    db.exec("DROP INDEX idx_threads_updated");
    expect(() => runMigrations(db)).toThrow(/missing indexes: idx_threads_updated/);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='jarela_migrations'").get()).toBeUndefined();
  });

  it("rejects an unknown newer migration", () => {
    const db = database();
    runMigrations(db);
    db.prepare("INSERT INTO jarela_migrations VALUES (?, ?)").run("4.0.0-future", "date");
    expect(() => runMigrations(db)).toThrow(/unknown migration/);
  });

  it("rolls back a failed baseline and retries cleanly", () => {
    const db = database();
    const exec = db.exec.bind(db);
    const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql.startsWith("CREATE TABLE jarela_migrations")) throw new Error("simulated failure");
      return exec(sql);
    });
    expect(() => runMigrations(db)).toThrow("simulated failure");
    spy.mockRestore();
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='threads'").get()).toBeUndefined();
    runMigrations(db);
    expect(db.prepare("SELECT id FROM jarela_migrations").all()).toEqual([{ id: "3.0.0-baseline" }]);
  });

  it("runs deferred encrypted data migration once, after the key is available", () => {
    getDb();
    const db = database();
    db.exec(releaseSchema);
    db.prepare("INSERT INTO model_configs (name, provider, model_id, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("old-model", "test", "model", JSON.stringify({ api_key: "test-key", temperature: 0.5 }), "date", "date");
    runMigrations(db);
    expect(db.prepare("SELECT id FROM jarela_migrations").all()).toHaveLength(1);
    runDeferredDataMigrations(db);
    expect(db.prepare("SELECT id FROM jarela_migrations ORDER BY id").all()).toHaveLength(3);
    const config = db.prepare("SELECT credential_id, params FROM model_configs WHERE name='old-model'").get();
    expect(config?.credential_id).toBe("model-test");
    expect(JSON.parse(decryptIfNeeded(String(config?.params)))).toEqual({ temperature: 0.5 });
    db.prepare("INSERT INTO model_configs (name, provider, model_id, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("later-model", "test", "model", encrypt('{"api_key":"another-test-key"}'), "date", "date");
    runDeferredDataMigrations(db);
    expect(db.prepare("SELECT id FROM credentials").all()).toEqual([{ id: "model-test" }]);
    expect(db.prepare("SELECT credential_id FROM model_configs WHERE name='later-model'").get()?.credential_id).toBeNull();
  });

  it("preserves integration fields and existing credentials during deferred migration", () => {
    getDb();
    const db = database();
    db.exec(releaseSchema);
    const insertMemory = db.prepare(
      "INSERT INTO memory_store (namespace, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    const gmail = { client_id: "client", client_secret: "test-secret", refresh_token: "test-token" };
    const jira = { url: "https://example.test", email: "test@example.test", api_token: "test-token" };
    insertMemory.run("integrations", "gmail", encrypt(JSON.stringify(gmail)), "date", "date");
    insertMemory.run("integrations", "jira", JSON.stringify(jira), "date", "date");
    insertMemory.run("integrations", "existing", JSON.stringify({ token: "old-token" }), "date", "date");
    insertMemory.run("facts", "unrelated", "do not migrate", "date", "date");
    db.prepare(
      "INSERT INTO credentials (id, type, provider, auth_method, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("integration-existing", "integration", "existing", "api_key", encrypt('{"token":"new-token"}'), "date", "date");
    runMigrations(db);
    runDeferredDataMigrations(db);
    const rows = db.prepare("SELECT id, auth_method, params FROM credentials ORDER BY id").all();
    expect(rows.map((row) => row.id)).toEqual(["integration-existing", "integration-gmail", "integration-jira"]);
    expect(rows.map((row) => row.auth_method)).toEqual(["api_key", "oauth", "api_key"]);
    expect(rows.map((row) => JSON.parse(decryptIfNeeded(String(row.params))))).toEqual([
      { token: "new-token" }, gmail, jira,
    ]);
    expect(rows.every((row) => String(row.params).startsWith("enc:v1:"))).toBe(true);
    runDeferredDataMigrations(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM credentials").get()?.count).toBe(3);
  });

  it("does not record a failed deferred data migration", () => {
    getDb();
    const db = database();
    db.exec(releaseSchema);
    db.prepare("INSERT INTO model_configs (name, provider, model_id, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("bad-model", "test", "model", "not-json", "date", "date");
    runMigrations(db);
    expect(() => runDeferredDataMigrations(db)).toThrow();
    expect(db.prepare("SELECT id FROM jarela_migrations").all()).toEqual([
      { id: "3.0.0-baseline" },
      { id: "3.0.0-deferred-crypto" },
    ]);
    // The crypto migration committed independently and already encrypted
    // this row at rest, even though reshaping — which runs after it, and
    // throws on this malformed value — never got to touch it.
    expect(decryptIfNeeded(String(db.prepare("SELECT params FROM model_configs").get()?.params))).toBe("not-json");
  });

  it("commits encryption even when credential reshaping later fails on an unrelated row", () => {
    getDb();
    const db = database();
    db.exec(releaseSchema);
    // A malformed legacy row that makes reshaping throw.
    db.prepare("INSERT INTO model_configs (name, provider, model_id, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("bad-model", "test", "model", "not-json", "date", "date");
    // An unrelated, otherwise-valid plaintext secret the crypto migration must encrypt.
    db.prepare("INSERT INTO mcp_servers (name, transport, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("good-server", "stdio", JSON.stringify({ command: "node", args: [] }), "date", "date");
    runMigrations(db);
    expect(() => runDeferredDataMigrations(db)).toThrow();
    // The crypto migration committed on its own — it is not rolled back by
    // the later-failing credential-reshaping migration.
    expect(db.prepare("SELECT id FROM jarela_migrations ORDER BY id").all()).toEqual([
      { id: "3.0.0-baseline" },
      { id: "3.0.0-deferred-crypto" },
    ]);
    expect(String(db.prepare("SELECT spec FROM mcp_servers WHERE name='good-server'").get()?.spec))
      .toMatch(/^enc:v1:/);
  });
});
