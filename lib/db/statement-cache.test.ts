import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { cachedRead, clearStatementCache } from "./statement-cache";

const databases: DatabaseSync[] = [];
function database() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) {
    clearStatementCache(db);
    db.close();
  }
});

describe("cached SQLite reads", () => {
  it("prepares once per SQL shape, rebinds parameters, and returns fresh rows", () => {
    const db = database();
    db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES(1,'one'),(2,'two')");
    const prepare = vi.spyOn(db, "prepare");
    const sql = "SELECT value FROM items WHERE id=?";
    expect(cachedRead(db, sql).get(1)).toEqual({ value: "one" });
    expect(cachedRead(db, sql).get(2)).toEqual({ value: "two" });
    expect(cachedRead(db, sql).get(3)).toBeUndefined();
    db.exec("UPDATE items SET value='updated' WHERE id=1");
    expect(cachedRead(db, sql).all(1)).toEqual([{ value: "updated" }]);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("isolates connections and releases cached references on clear", () => {
    const first = database();
    const second = database();
    const sql = "SELECT ? AS value";
    expect(cachedRead(first, sql)).not.toBe(cachedRead(second, sql));
    const original = cachedRead(first, sql);
    clearStatementCache(first);
    expect(cachedRead(first, sql)).not.toBe(original);
    expect(cachedRead(second, sql).get("second")).toEqual({ value: "second" });
  });

  it("evicts least recently used statements after 128 SQL shapes", () => {
    const db = database();
    const oldest = cachedRead(db, "SELECT 0");
    const recent = cachedRead(db, "SELECT 1");
    for (let i = 2; i < 128; i++) cachedRead(db, `SELECT ${i}`);
    expect(cachedRead(db, "SELECT 0")).toBe(oldest);
    cachedRead(db, "SELECT 128");
    expect(cachedRead(db, "SELECT 0")).toBe(oldest);
    expect(cachedRead(db, "SELECT 1")).not.toBe(recent);
  });

  it("surfaces SQL errors without caching a failed prepare", () => {
    const db = database();
    expect(() => cachedRead(db, "SELECT * FROM missing")).toThrow();
    db.exec("CREATE TABLE missing(id INTEGER)");
    expect(cachedRead(db, "SELECT * FROM missing").all()).toEqual([]);
    expect(() => cachedRead(db, "SELECT ? AS value").get({ unsupported: "value" })).toThrow();
    expect(cachedRead(db, "SELECT ? AS value").get("valid")).toEqual({ value: "valid" });
  });

  it("refreshes column metadata after explicit schema invalidation and observes rollback", () => {
    const db = database();
    db.exec("CREATE TABLE items(id INTEGER); INSERT INTO items VALUES(1)");
    const sql = "SELECT * FROM items";
    expect(cachedRead(db, sql).all()).toEqual([{ id: 1 }]);
    db.exec("ALTER TABLE items ADD COLUMN label TEXT DEFAULT 'new'");
    clearStatementCache(db);
    expect(cachedRead(db, sql).all()).toEqual([{ id: 1, label: "new" }]);
    db.exec("BEGIN; INSERT INTO items(id) VALUES(2)");
    expect(cachedRead(db, sql).all()).toHaveLength(2);
    db.exec("ROLLBACK");
    expect(cachedRead(db, sql).all()).toEqual([{ id: 1, label: "new" }]);
  });
});
