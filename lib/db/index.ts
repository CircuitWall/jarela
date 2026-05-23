import { DatabaseSync } from "node:sqlite";
import { join } from "path";
import { runMigrations } from "./migrations";
import { getDataDir } from "./data-dir";
import { initMasterKey } from "@/lib/crypto/master-key";
import { runCryptoMigration } from "@/lib/crypto/migrate";
import { applyProxyConfigFromDb } from "@/lib/proxy/dispatcher"; // env-var dispatcher applied at module load; DB layer applied below
import { runEnvSyncOnce } from "@/lib/env/sync";

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
    // Layer DB-backed proxy config on top of the env-var dispatcher
    // (ADR-0009). Fire-and-forget — keeps getDb() synchronous so existing
    // call sites stay unchanged. Errors are logged but don't break boot;
    // worst case we fall back to direct connection.
    applyProxyConfigFromDb().catch((err) =>
      console.warn("[jarela/proxy] applyProxyConfigFromDb failed at boot:", err),
    );
    // Pull rc-defined credential env vars into the encrypted integration
    // store so installed launchers (LaunchAgent / systemd-user) — which
    // never source the user's shell rc — pick up tokens automatically
    // and survive rotation. Best-effort; never blocks boot.
    runEnvSyncOnce().then((r) => {
      if (r && r.applied_count > 0) {
        console.log(
          `[jarela/env-sync] applied ${r.applied_count} field(s) from ${r.discovered.source}`,
        );
      }
    });
  }
  return _db;
}

// Close the SQLite handle so WAL is checkpointed and the lock is released
// before the process exits. Called from the graceful-shutdown path. Safe
// to call when the DB was never opened (no-op). Best-effort: WAL files
// stay valid even on hard kills because SQLite is crash-resilient, but
// a clean close means no stale -shm/-wal sidecars and a faster next boot.
export function closeDb(): void {
  if (!_db) return;
  const db = _db;
  _db = null;
  try {
    // PRAGMA optimize is cheap (<1ms typically) and lets SQLite run any
    // pending analyze work it would otherwise defer; safe on shutdown.
    db.exec("PRAGMA optimize");
  } catch { /* not fatal — proceed with close */ }
  try {
    db.close();
  } catch (err) {
    console.warn("[jarela] closeDb: close failed:", err);
  }
}
