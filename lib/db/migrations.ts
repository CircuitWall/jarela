import { DatabaseSync } from "node:sqlite";
import { clearStatementCache } from "./statement-cache";
import { BASELINE_V3_COLUMNS, BASELINE_V3_INDEXES, BASELINE_V3_SQL } from "./baseline-v3";
import { runCryptoMigration } from "@/lib/crypto/migrate";
import {
  migrateInlineApiKeysToCredentials,
  migrateIntegrationsToCredentials,
} from "./legacy-credentials-v3";

const BASELINE = "3.0.0-baseline";
const DEFERRED_CRYPTO = "3.0.0-deferred-crypto";
const DEFERRED_DATA = "3.0.0-deferred-credentials";

interface Migration {
  id: string;
  apply(db: DatabaseSync): void;
}

const SCHEMA_MIGRATIONS: readonly Migration[] = [{
  // ADR-0119. Existing databases gain the full-text index used for targeted
  // recall candidate generation. Creating the virtual table and rebuilding the
  // index measured ~0.4s for 11k messages; drafts are skipped by the triggers,
  // so the streaming draft path never re-tokenizes.
  id: "3.5.8-message-full-text",
  apply(db) {
    const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='messages_fts'").get();
    if (!exists) {
      db.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid')");
      db.exec("INSERT INTO messages_fts(rowid, content) SELECT rowid, substr(content, 1, 2000) FROM messages WHERE transcript_status = 'completed'");
    }
    db.exec("CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages\nWHEN new.transcript_status = 'completed'\nBEGIN\n  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, substr(new.content, 1, 2000));\nEND;");
    db.exec("CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages\nWHEN old.transcript_status = 'completed'\nBEGIN\n  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, substr(old.content, 1, 2000));\nEND;");
    db.exec("CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content, transcript_status ON messages\nBEGIN\n  INSERT INTO messages_fts(messages_fts, rowid, content)\n    SELECT 'delete', old.rowid, substr(old.content, 1, 2000) WHERE old.transcript_status = 'completed';\n  INSERT INTO messages_fts(rowid, content)\n    SELECT new.rowid, substr(new.content, 1, 2000) WHERE new.transcript_status = 'completed';\nEND;");
  },
}, {
  // ADR-0131. Per-agent voice *input* engine: 'gemini' (the pre-existing
  // behaviour, kept as the default so upgrades are a no-op), 'browser'
  // (Web Speech API, no key/network from the server) or 'whisper' (local
  // tiny ONNX model installed on demand).
  id: "3.7.1-voice-stt-engine",
  apply(db) {
    const columns = db.prepare("SELECT name FROM pragma_table_info('agent_configs')").all();
    if (!columns.some((column) => column.name === "voice_stt_engine")) {
      db.exec("ALTER TABLE agent_configs ADD COLUMN voice_stt_engine TEXT NOT NULL DEFAULT 'gemini'");
    }
  },
}, {
  // ADR-0132. Per-agent device voice for the Browser/Whisper speech path.
  // Empty string = the device default, so upgrades speak exactly as before.
  id: "3.7.2-browser-voice",
  apply(db) {
    const columns = db.prepare("SELECT name FROM pragma_table_info('agent_configs')").all();
    if (!columns.some((column) => column.name === "voice_browser_voice")) {
      db.exec("ALTER TABLE agent_configs ADD COLUMN voice_browser_voice TEXT NOT NULL DEFAULT ''");
    }
  },
}, {
  // ADR-0133. Disabled sources keep their chunks so re-enabling is instant.
  // This records when the source was disabled so the opt-in retention sweep
  // can purge an index only after its grace period. Existing disabled rows
  // adopt their last update time, the best approximation available.
  id: "3.8.2-document-index-lifecycle",
  apply(db) {
    const columns = db.prepare("SELECT name FROM pragma_table_info('document_sources')").all();
    if (!columns.some((column) => column.name === "disabled_at")) {
      db.exec("ALTER TABLE document_sources ADD COLUMN disabled_at TEXT");
    }
    db.exec("UPDATE document_sources SET disabled_at=updated_at WHERE enabled=0 AND disabled_at IS NULL");
  },
}, {
  // ADR-0135. Idle consolidation is a first-class scheduled workload, not a
  // scheduled task: it must be silent, bounded, and opted out per agent.
  id: "3.8.3-agent-dreaming",
  apply(db) {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name),
    );
    if (!tables.has("agent_dream_state")) {
      db.exec(`CREATE TABLE agent_dream_state (
  agent_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_light_dream_at TEXT,
  last_light_attempt_at TEXT,
  last_light_boundary_seq INTEGER,
  last_deep_dream_at TEXT,
  last_deep_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
    }
    if (!tables.has("agent_dream_runs")) {
      db.exec(`CREATE TABLE agent_dream_runs (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('light','deep')),
  status TEXT NOT NULL CHECK (status IN ('running','completed','partial','failed','skipped')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT,
  stats TEXT,
  estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_output_tokens INTEGER NOT NULL DEFAULT 0,
  error TEXT
)`);
    }
    // The deep-dream idle check asks for the newest foreground user turn across
    // every thread. A partial index keeps that cheap on automation-heavy
    // installs instead of scanning backwards through scheduled-task rows.
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_messages_foreground_user_created_at'").get()) {
      db.exec("CREATE INDEX idx_messages_foreground_user_created_at ON messages(created_at DESC) WHERE role='user' AND category IS NULL");
    }
    const indexes = new Set(
      db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'idx_agent_dream%'")
        .all().map((row) => row.name),
    );
    if (!indexes.has("idx_agent_dream_runs_agent_started")) {
      db.exec("CREATE INDEX idx_agent_dream_runs_agent_started ON agent_dream_runs(agent_id, started_at DESC)");
    }
    if (!indexes.has("idx_agent_dream_runs_started")) {
      db.exec("CREATE INDEX idx_agent_dream_runs_started ON agent_dream_runs(started_at)");
    }
  },
}];
// Encryption commits as its own migration, separate from credential
// reshaping below. Reshaping reads already-encrypted `memory_store` rows
// (see SENSITIVE_MEMORY_NAMESPACES) — a malformed legacy row must not make
// a transaction rollback undo the encryption of other, unrelated secrets.
const DEFERRED_MIGRATIONS: readonly Migration[] = [{
  id: DEFERRED_CRYPTO,
  apply(db) {
    runCryptoMigration(db);
  },
}, {
  id: DEFERRED_DATA,
  apply(db) {
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
    // ADR-0133: new databases opt into incremental auto-vacuum before the
    // first table exists. The pragma cannot be enabled on an existing file
    // without a full VACUUM, which stays an explicit maintenance action.
    const hasTables = db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
    ).get();
    if (!hasTables) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
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
