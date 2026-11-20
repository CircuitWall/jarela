// Connection-level SQLite tuning for every long-lived connection.
//
// The app database is multi-gigabyte and written from the request path, so
// SQLite's defaults cost more than they buy:
//
//   - `synchronous=FULL` (the default) fsyncs the WAL on every commit. Measured
//     on a 3 GB database: an autocommit single-row UPDATE took 2.1 ms at FULL
//     and 0.02 ms at NORMAL, and the one commit that tripped the autocheckpoint
//     also paid a 411 ms flush of the database file.
//   - `busy_timeout=0` (the default) turns a concurrent writer — a CLI, a
//     script, a second instance — into an instant SQLITE_BUSY instead of a
//     short wait.
//   - `cache_size=-2000` (2 MiB) thrashes against a 3 GB file.
//   - WAL files keep their high-water mark forever, so one burst leaves a
//     large file for antivirus and backups to chew on.
//
// WAL + NORMAL remains crash-safe: a process crash loses nothing, only a power
// loss or OS crash can roll back the most recent commits. See ADR-0124.

import type { DatabaseSync } from "node:sqlite";

/**
 * The values `applyConnectionPragmas` leaves behind, for tests and docs.
 * SQLite does not accept bound parameters in `PRAGMA`, so the widths below are
 * repeated as literals in the statements; this object is what keeps them honest.
 */
export const SQLITE_PRAGMA_PROFILE = {
  journal_mode: "wal",
  synchronous: 1, // NORMAL
  busy_timeout: 5_000,
  cache_size: -65_536, // 64 MiB per connection
  journal_size_limit: 33_554_432, // 32 MiB
  foreign_keys: 1,
} as const;

export function applyConnectionPragmas(db: Pick<DatabaseSync, "exec">): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA cache_size = -65536");
  db.exec("PRAGMA journal_size_limit = 33554432");
  db.exec("PRAGMA foreign_keys = ON");
}
