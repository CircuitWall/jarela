import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-pragmas-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { closeDb, getDb } = await import("@/lib/db");
const { SQLITE_PRAGMA_PROFILE, applyConnectionPragmas } = await import("./pragmas");

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("applyConnectionPragmas", () => {
  it("leaves the app database on the documented profile", () => {
    const db = getDb();
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: SQLITE_PRAGMA_PROFILE.journal_mode });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: SQLITE_PRAGMA_PROFILE.synchronous });
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: SQLITE_PRAGMA_PROFILE.busy_timeout });
    expect(db.prepare("PRAGMA cache_size").get()).toEqual({ cache_size: SQLITE_PRAGMA_PROFILE.cache_size });
    expect(db.prepare("PRAGMA journal_size_limit").get()).toEqual({
      journal_size_limit: SQLITE_PRAGMA_PROFILE.journal_size_limit,
    });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: SQLITE_PRAGMA_PROFILE.foreign_keys });
  });

  it("applies the same profile to any other long-lived connection", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyConnectionPragmas(db);
      expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: SQLITE_PRAGMA_PROFILE.synchronous });
      expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: SQLITE_PRAGMA_PROFILE.busy_timeout });
      expect(db.prepare("PRAGMA cache_size").get()).toEqual({ cache_size: SQLITE_PRAGMA_PROFILE.cache_size });
      expect(db.prepare("PRAGMA journal_size_limit").get()).toEqual({
        journal_size_limit: SQLITE_PRAGMA_PROFILE.journal_size_limit,
      });
    } finally {
      db.close();
    }
  });
});
