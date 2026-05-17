import { DatabaseSync } from "node:sqlite";
import { join } from "path";
import { runMigrations } from "./migrations";
import { getDataDir } from "./data-dir";
import "@/lib/network"; // configure undici proxy dispatcher from env

export const DB_PATH = join(getDataDir(), "jarela.db");

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    const db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    _db = db; // only assign after migrations succeed
  }
  return _db;
}
