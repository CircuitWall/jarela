import { DatabaseSync } from "node:sqlite";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { join } from "path";
import { runMigrations } from "./migrations";
import "@/lib/network"; // configure undici proxy dispatcher from env

const dbDir = process.env.LANGGUI_DB_DIR
  ? process.env.LANGGUI_DB_DIR.replace("~", homedir())
  : join(homedir(), ".langgui");

mkdirSync(dbDir, { recursive: true });

export const DB_PATH = join(dbDir, "langgui.db");

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
