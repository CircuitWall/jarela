import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { instrumentDatabase } from "./timing";

describe("instrumentDatabase", () => {
  it("forwards queries unchanged and reports the SQL of slow statements", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)");
    const sink = vi.fn();
    const db = instrumentDatabase(raw, { slowMs: 0, sink });

    db.prepare("INSERT INTO t (value) VALUES (?)").run("one");
    expect(db.prepare("SELECT value FROM t WHERE id = ?").get(1)).toEqual({ value: "one" });
    expect(db.prepare("SELECT value FROM t").all()).toEqual([{ value: "one" }]);

    const sqls = sink.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " ").trim());
    expect(sqls).toContain("INSERT INTO t (value) VALUES (?)");
    expect(sqls).toContain("SELECT value FROM t WHERE id = ?");
    const allCall = sink.mock.calls.find(([sql]) => String(sql).includes("SELECT value FROM t"));
    expect(allCall?.[2]).toBe(1);
    raw.close();
  });

  it("reports nothing when the threshold is above every call", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const sink = vi.fn();
    const db = instrumentDatabase(raw, { slowMs: 60_000, sink });
    db.prepare("SELECT COUNT(*) AS c FROM t").get();
    expect(sink).not.toHaveBeenCalled();
    raw.close();
  });

  it("keeps statement options and lazy iteration working through the wrapper", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    raw.exec("INSERT INTO t DEFAULT VALUES; INSERT INTO t DEFAULT VALUES");
    const db = instrumentDatabase(raw, { slowMs: 60_000, sink: () => undefined });
    const statement = db.prepare("SELECT id FROM t ORDER BY id");
    expect([...statement.iterate()].length).toBe(2);
    expect(statement.all().length).toBe(2);
    raw.close();
  });
});
