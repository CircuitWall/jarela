import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeReadPool, readRowsAsync } from "./read-pool";

const root = mkdtempSync(join(tmpdir(), "jarela-read-pool-"));
const filename = join(root, "reader.db");
const writer = new DatabaseSync(filename);
writer.exec("PRAGMA journal_mode = WAL; CREATE TABLE sample (value INTEGER NOT NULL)");
writer.prepare("INSERT INTO sample (value) VALUES (?)").run(7);

afterAll(async () => {
  await closeReadPool();
  writer.close();
  rmSync(root, { recursive: true, force: true });
});

describe("worker-backed SQLite reads", () => {
  it("leaves the event loop free while a long read runs and permits a WAL write", async () => {
    await readRowsAsync(filename, "SELECT value FROM sample WHERE value=?", [7]);
    let timerRan = false;
    let queryFinished = false;
    const read = readRowsAsync<{ total: number }>(
      filename,
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2000000) SELECT sum(x) + (SELECT value FROM sample WHERE value=7) AS total FROM n",
    ).then((rows) => {
      queryFinished = true;
      return rows;
    });
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerRan = true;
        writer.prepare("INSERT INTO sample (value) VALUES (?)").run(8);
        resolve();
      }, 0);
    });

    await timer;
    expect(timerRan).toBe(true);
    expect(queryFinished).toBe(false);
    expect(await read).toEqual([{ total: 2000001000007 }]);
    expect(writer.prepare("SELECT COUNT(*) AS n FROM sample").get()).toEqual({ n: 2 });
  }, 15_000);

  it("runs independent reads through the reader pool and returns bound results", async () => {
    const results = await Promise.all([
      readRowsAsync<{ value: number }>(filename, "SELECT value FROM sample WHERE value=?", [7]),
      readRowsAsync<{ value: number }>(filename, "SELECT value FROM sample WHERE value=?", [8]),
      readRowsAsync<{ value: number }>(filename, "SELECT value FROM sample WHERE value=?", [99]),
    ]);

    expect(results).toEqual([[{ value: 7 }], [{ value: 8 }], []]);
  });
});
