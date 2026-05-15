import { DatabaseSync } from "node:sqlite";

const now = () => new Date().toISOString();

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      thread_id     TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      title         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      msg_id     TEXT PRIMARY KEY,
      thread_id  TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_store (
      namespace  TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, key)
    );
    CREATE TABLE IF NOT EXISTS model_configs (
      name       TEXT PRIMARY KEY,
      provider   TEXT NOT NULL,
      model_id   TEXT NOT NULL,
      params     TEXT NOT NULL DEFAULT '{}',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_assignments (
      agent_id          TEXT PRIMARY KEY,
      model_config_name TEXT NOT NULL,
      allow_tools       TEXT NOT NULL DEFAULT '[]',
      deny_tools        TEXT NOT NULL DEFAULT '[]',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_profile (
      id         TEXT PRIMARY KEY DEFAULT 'me',
      name       TEXT NOT NULL DEFAULT '',
      icon       TEXT,
      about      TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_configs (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      icon              TEXT,
      identity          TEXT NOT NULL DEFAULT '',
      instructions      TEXT NOT NULL DEFAULT '',
      tools             TEXT NOT NULL DEFAULT '[]',
      model_config_name TEXT,
      is_default        INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      description   TEXT,
      kind          TEXT NOT NULL,
      schedule      TEXT NOT NULL,
      next_run_at   TEXT NOT NULL,
      last_run_at   TEXT,
      last_error    TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
    CREATE TABLE IF NOT EXISTS mcp_servers (
      name          TEXT PRIMARY KEY,
      transport     TEXT NOT NULL,           -- 'stdio' | 'http'
      spec          TEXT NOT NULL DEFAULT '{}',  -- JSON: { command, args, env } or { url, headers }
      enabled       INTEGER NOT NULL DEFAULT 1,
      last_error    TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_actions (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,           -- which agent proposed it
      kind          TEXT NOT NULL,           -- 'install_mcp' | 'toggle_mcp' | 'update_agent_tools' | 'update_agent'
      payload       TEXT NOT NULL,           -- JSON parameters
      reason        TEXT,                    -- agent's stated rationale
      status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | denied | failed
      result        TEXT,                    -- JSON result on success, error message on failure
      created_at    TEXT NOT NULL,
      decided_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_actions(status, created_at);
    CREATE TABLE IF NOT EXISTS access_whitelist (
      identity      TEXT PRIMARY KEY,
      display_name  TEXT,
      added_at      TEXT NOT NULL,
      last_seen_at  TEXT
    );
  `);
  ensureAgentConfigColumns(db);
  ensureTaskAssignmentColumns(db);
  ensureEmbeddingColumns(db);
  ensureThreadsAgentIdUnique(db);
  seedModelConfigs(db);
  seedAgentConfigs(db);
}

function ensureEmbeddingColumns(db: DatabaseSync): void {
  // Embeddings stored as JSON-encoded float[] in TEXT to keep migration simple.
  // For the corpus sizes we expect (thousands of rows), in-memory cosine
  // similarity in JS is fast enough — no need for sqlite-vec or duckdb yet.
  const memCols = db.prepare("PRAGMA table_info(memory_store)").all() as Array<{ name: string }>;
  if (!new Set(memCols.map((c) => c.name)).has("embedding")) {
    db.exec("ALTER TABLE memory_store ADD COLUMN embedding TEXT");
  }
  const msgCols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!new Set(msgCols.map((c) => c.name)).has("embedding")) {
    db.exec("ALTER TABLE messages ADD COLUMN embedding TEXT");
  }
}

function ensureThreadsAgentIdUnique(db: DatabaseSync): void {
  // Check if index already exists — skip if so
  const idx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_threads_agent_id'"
  ).get();
  if (idx) return;

  // Delete orphaned messages for duplicate threads before removing them
  db.exec(`
    DELETE FROM messages WHERE thread_id IN (
      SELECT thread_id FROM threads
      WHERE rowid NOT IN (SELECT MAX(rowid) FROM threads GROUP BY agent_id)
    )
  `);

  // Keep only the last-inserted thread per agent (by rowid)
  db.exec(`
    DELETE FROM threads
    WHERE rowid NOT IN (SELECT MAX(rowid) FROM threads GROUP BY agent_id)
  `);

  db.exec("CREATE UNIQUE INDEX idx_threads_agent_id ON threads(agent_id)");
}

function ensureAgentConfigColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(agent_configs)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("is_default")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE agent_configs SET is_default=1 WHERE id='assistant'");
  }
  if (!names.has("history_limit")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN history_limit INTEGER NOT NULL DEFAULT 50");
  }
  if (!names.has("history_window_hours")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN history_window_hours INTEGER NOT NULL DEFAULT 8");
  }
}

function ensureTaskAssignmentColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(task_assignments)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));

  if (!names.has("allow_tools")) {
    db.exec("ALTER TABLE task_assignments ADD COLUMN allow_tools TEXT NOT NULL DEFAULT '[]'");
  }
  if (!names.has("deny_tools")) {
    db.exec("ALTER TABLE task_assignments ADD COLUMN deny_tools TEXT NOT NULL DEFAULT '[]'");
  }
}

function seedAgentConfigs(db: DatabaseSync): void {
  // Only seed on first run — once the user has any agents we must not
  // resurrect ones they've deleted (e.g. the legacy "echo" / "llm" defaults).
  const count = (db.prepare("SELECT COUNT(*) as n FROM agent_configs").get() as { n: number }).n;
  if (count > 0) {
    // Still keep threads pointing at a real agent, in case an agent was deleted.
    const fallback = (db.prepare(
      "SELECT id FROM agent_configs ORDER BY is_default DESC, created_at ASC LIMIT 1"
    ).get() as { id: string } | undefined)?.id;
    if (fallback) {
      db.prepare(
        `UPDATE threads SET agent_id = ?
         WHERE agent_id NOT IN (SELECT id FROM agent_configs)`
      ).run(fallback);
    }
    return;
  }

  const t = now();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO agent_configs (id, name, icon, identity, instructions, tools, model_config_name, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // Default agent for new installs
  insert.run("assistant", "Assistant", null, "You are a helpful assistant.", "", "[]", null, 1, t, t);
  // Backward-compat: pre-migration threads used agent_id="llm" or "echo"
  insert.run("llm", "LLM Agent", null, "You are a helpful assistant.", "", "[]", null, 0, t, t);
  insert.run("echo", "Echo", null, "", "", "[]", null, 0, t, t);

  // Point any threads whose agent_id has no matching agent_config to the default agent
  const fallback = (db.prepare(
    "SELECT id FROM agent_configs ORDER BY created_at ASC LIMIT 1"
  ).get() as { id: string } | undefined)?.id;
  if (fallback) {
    db.prepare(
      `UPDATE threads SET agent_id = ?
       WHERE agent_id NOT IN (SELECT id FROM agent_configs)`
    ).run(fallback);
  }
}

function seedModelConfigs(db: DatabaseSync): void {
  // Only seed on first run — if any row exists, the user has already managed
  // their configs and we must not resurrect anything they deleted.
  const count = (db.prepare("SELECT COUNT(*) as n FROM model_configs").get() as { n: number }).n;
  if (count > 0) return;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO model_configs (name, provider, model_id, params, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const t = now();
  const seeds: [string, string, string, string, number, string, string][] = [
    ["claude-sonnet",  "anthropic", "claude-sonnet-4-6", "{}", 0, t, t],
    ["gpt-4o",         "openai",    "gpt-4o",            "{}", 0, t, t],
    ["github-copilot", "github-copilot", "gpt-4o",       "{}", 0, t, t],

  ];
  for (const s of seeds) insert.run(...s);
}
