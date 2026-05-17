import { DatabaseSync } from "node:sqlite";
import { join } from "path";
import { runMigrations } from "./migrations";
import { getDataDir } from "./data-dir";
import { initMasterKey } from "@/lib/crypto/master-key";
import { runCryptoMigration } from "@/lib/crypto/migrate";
import "@/lib/network"; // configure undici proxy dispatcher from env

export const DB_PATH = join(getDataDir(), "jarela.db");

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    // Bootstrap the at-rest encryption master key (ADR-0005) before any
    // store touches the DB. initMasterKey is synchronous and idempotent.
    const { source } = initMasterKey(getDataDir());
    if (source === "keyfile") {
      console.warn(
        "[jarela] using keyfile fallback for at-rest encryption — keychain " +
          "access failed. The master key lives next to the DB; protect the " +
          "data directory accordingly. See ADR-0005.",
      );
    }
    const db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    // One-time encryption migration: rewrites legacy plaintext rows in
    // the four secret-bearing surfaces with enc:v1: envelopes. Idempotent.
    runCryptoMigration(db);
    _db = db; // only assign after migrations succeed
  }
  return _db;
}
