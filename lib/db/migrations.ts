import { DatabaseSync } from "node:sqlite";
import { clearStatementCache } from "./statement-cache";
import { BASELINE_V3_COLUMNS, BASELINE_V3_INDEXES, BASELINE_V3_SQL } from "./baseline-v3";
import { runCryptoMigration } from "@/lib/crypto/migrate";
import {
  migrateInlineApiKeysToCredentials,
  migrateIntegrationsToCredentials,
} from "./legacy-credentials-v3";

const BASELINE = "3.0.0-baseline";
const DEFERRED_DATA = "3.0.0-deferred-credentials";

interface Migration {
  id: string;
  apply(db: DatabaseSync): void;
}

const SCHEMA_MIGRATIONS: readonly Migration[] = [];
const DEFERRED_MIGRATIONS: readonly Migration[] = [{
  id: DEFERRED_DATA,
  apply(db) {
    runCryptoMigration(db);
    migrateInlineApiKeysToCredentials(db);
    migrateIntegrationsToCredentials(db);
  },
}];
export const SUPPORTED_MIGRATION_IDS: readonly string[] = [
  BASELINE,
  ...SCHEMA_MIGRATIONS.map((migration) => migration.id),
  ...DEFERRED_MIGRATIONS.map((migration) => migration.id),
];
const KNOWN_MIGRATIONS = new Set<string>(SUPPORTED_MIGRATION_IDS);

function appliedMigrations(db: DatabaseSync): Set<string> | null {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='jarela_migrations'",
  ).get();
  if (!table) return null;
  const rows = db.prepare("SELECT id FROM jarela_migrations").all();
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.id !== "string" || !KNOWN_MIGRATIONS.has(row.id)) {
      throw new Error("This database has an unknown migration. Open it with a compatible newer Jarela version.");
    }
    ids.add(row.id);
  }
  if (!ids.has(BASELINE)) throw new Error("The Jarela migration marker is incomplete; restore a backup.");
  return ids;
}

function validateV3Baseline(db: DatabaseSync): void {
  for (const [table, expectedColumns] of Object.entries(BASELINE_V3_COLUMNS)) {
    const actualColumns = new Set(
      db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((row) => row.name),
    );
    const missing = expectedColumns.filter((name) => !actualColumns.has(name));
    if (missing.length) {
      throw new Error(
        `Database does not match the Jarela 3.0 baseline (${table}: missing ${missing.join(", ")}). `
        + "Back up the data and run Jarela 3.0 with the database unlocked before upgrading.",
      );
    }
  }
  const indexes = new Set(
    db.prepare("SELECT name FROM sqlite_schema WHERE type='index'").all().map((row) => row.name),
  );
  const missingIndexes = BASELINE_V3_INDEXES.filter((name) => !indexes.has(name));
  if (missingIndexes.length) {
    throw new Error(
      `Database does not match the Jarela 3.0 baseline (missing indexes: ${missingIndexes.join(", ")}). `
      + "Back up the data and run Jarela 3.0 with the database unlocked before upgrading.",
    );
  }
}

function transaction(db: DatabaseSync, work: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function runMigrations(db: DatabaseSync): void {
  if (!appliedMigrations(db)) {
    clearStatementCache(db);
    transaction(db, () => {
      if (appliedMigrations(db)) return;
      const tables = db.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      ).all();
      if (tables.length === 0) {
        db.exec(BASELINE_V3_SQL);
        db.exec("INSERT INTO message_seq_allocator (id, last_seq) VALUES (1, 0)");
      } else {
        validateV3Baseline(db);
        if (!db.prepare("SELECT 1 FROM message_seq_allocator WHERE id=1").get()) {
          throw new Error("Database is missing the 3.0 message sequence allocator; run Jarela 3.0 before upgrading.");
        }
      }
      db.exec("CREATE TABLE jarela_migrations (id TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)");
      db.prepare("INSERT INTO jarela_migrations (id, applied_at) VALUES (?, ?)").run(BASELINE, new Date().toISOString());
    });
    clearStatementCache(db);
  }
  if (applyPendingMigrations(db, SCHEMA_MIGRATIONS, true)) clearStatementCache(db);
}

function applyPendingMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  changesSchema = false,
): boolean {
  let changed = false;
  for (const migration of migrations) {
    const applied = appliedMigrations(db);
    if (!applied) throw new Error("Database baseline migration has not been applied.");
    if (applied.has(migration.id)) continue;
    transaction(db, () => {
      const current = appliedMigrations(db);
      if (!current) throw new Error("Database baseline migration has not been applied.");
      if (current.has(migration.id)) return;
      if (changesSchema) clearStatementCache(db);
      migration.apply(db);
      db.prepare("INSERT INTO jarela_migrations (id, applied_at) VALUES (?, ?)")
        .run(migration.id, new Date().toISOString());
      changed = true;
    });
  }
  return changed;
}

export function runDeferredDataMigrations(db: DatabaseSync): void {
  applyPendingMigrations(db, DEFERRED_MIGRATIONS);
}
