import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-transaction-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { closeDb, getDb } = await import("./index");
const { withDbTransaction } = await import("./transaction");

afterAll(() => {
  closeDb();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("withDbTransaction", () => {
  it("rolls back all writes when the operation throws", () => {
    const db = getDb();
    db.exec("CREATE TABLE transaction_test (value TEXT NOT NULL)");

    expect(() => withDbTransaction(() => {
      db.prepare("INSERT INTO transaction_test(value) VALUES (?)").run("partial");
      throw new Error("abort");
    })).toThrow("abort");
    expect(db.prepare("SELECT value FROM transaction_test").all()).toEqual([]);
  });
});