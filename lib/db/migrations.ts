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
    -- thread_id is the dominant filter on every messages query
    -- (getMessages, getRecentMessagesWindow, getMessagesPage, clear).
    -- Without this every read full-scans the messages table.
    CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id, created_at);
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
    -- agent_id is a common filter on listPendingActions; without this every
    -- per-agent panel render is a full scan of pending_actions.
    CREATE INDEX IF NOT EXISTS idx_pending_actions_agent_status ON pending_actions(agent_id, status, created_at);
    CREATE TABLE IF NOT EXISTS access_whitelist (
      identity      TEXT PRIMARY KEY,
      display_name  TEXT,
      added_at      TEXT NOT NULL,
      last_seen_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS bridges (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,                       -- 'whatsapp' (only kind in v1)
      name        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'disconnected',-- disconnected | pairing | connected | error
      qr          TEXT,                                -- base64 data URL while status='pairing'
      last_error  TEXT,
      paired_id   TEXT,                                -- the remote-account identifier (e.g. WhatsApp phone JID) once paired
      enabled     INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bridge_routes (
      id          TEXT PRIMARY KEY,
      bridge_id   TEXT NOT NULL,
      remote_jid  TEXT NOT NULL,                       -- e.g. 5511...@s.whatsapp.net or ...@g.us
      agent_id    TEXT NOT NULL,
      label       TEXT,                                -- user-visible name (push_name on first inbound)
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      UNIQUE(bridge_id, remote_jid),
      UNIQUE(agent_id)                                 -- one route per agent: chats never interleave inside one agent's thread
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_routes_bridge ON bridge_routes(bridge_id);
    -- HTTP/HTTPS proxy configuration (ADR-0009). Single-row table; the
    -- CHECK constraint enforces it. Non-secret fields are plaintext for
    -- diagnostics; password goes through lib/crypto/envelope.ts.
    CREATE TABLE IF NOT EXISTS proxy_config (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      mode        TEXT    NOT NULL CHECK (mode IN ('off', 'manual', 'system')),
      host        TEXT,
      port        INTEGER,
      username    TEXT,
      password    TEXT,                                  -- envelope-encrypted (enc:v1:…)
      no_proxy    TEXT,
      updated_at  TEXT    NOT NULL
    );
  `);
  ensureBridgeRouteColumns(db);
  ensureAgentConfigColumns(db);
  ensureTaskAssignmentColumns(db);
  ensureEmbeddingColumns(db);
  ensureUserProfileLocationColumns(db);
  ensureThreadsAgentIdUnique(db);
  seedModelConfigs(db);
  seedAgentConfigs(db);
}

function ensureEmbeddingColumns(db: DatabaseSync): void {  // Embeddings stored as JSON-encoded float[] in TEXT to keep migration simple.
  // For the corpus sizes we expect (thousands of rows), in-memory cosine
  // similarity in JS is fast enough — no need for sqlite-vec or duckdb yet.
  const memCols = db.prepare("PRAGMA table_info(memory_store)").all() as Array<{ name: string }>;
  if (!new Set(memCols.map((c) => c.name)).has("embedding")) {
    db.exec("ALTER TABLE memory_store ADD COLUMN embedding TEXT");
  }
  const msgColSet = new Set(
    (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!msgColSet.has("embedding")) {
    db.exec("ALTER TABLE messages ADD COLUMN embedding TEXT");
  }
  if (!msgColSet.has("tool_events")) {
    // JSON array of { id, phase: "call"|"result", name, payload } captured at
    // stream time. Lets the chat UI render historical tool invocations the
    // same way it renders live ones — instead of only the *— used: x* footer
    // text, which loses arguments + results on reload.
    db.exec("ALTER TABLE messages ADD COLUMN tool_events TEXT");
  }
}

function ensureUserProfileLocationColumns(db: DatabaseSync): void {
  // Browser-reported geolocation, opt-in. Lets the agent answer
  // "what's near me?" / suggest routes / weather / etc. without the user
  // re-typing their location every turn. `location_consent` is the
  // explicit opt-in flag — when 0 the client must NOT post coordinates
  // and the agent must NOT see a stored value.
  const cols = db.prepare("PRAGMA table_info(user_profile)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("location_lat"))         db.exec("ALTER TABLE user_profile ADD COLUMN location_lat REAL");
  if (!names.has("location_lng"))         db.exec("ALTER TABLE user_profile ADD COLUMN location_lng REAL");
  if (!names.has("location_accuracy_m"))  db.exec("ALTER TABLE user_profile ADD COLUMN location_accuracy_m REAL");
  if (!names.has("location_label"))       db.exec("ALTER TABLE user_profile ADD COLUMN location_label TEXT");
  if (!names.has("location_updated_at"))  db.exec("ALTER TABLE user_profile ADD COLUMN location_updated_at TEXT");
  if (!names.has("location_consent"))     db.exec("ALTER TABLE user_profile ADD COLUMN location_consent INTEGER NOT NULL DEFAULT 0");
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
  // never_reply: when 1, the dispatcher records the inbound message and
  // the agent's response in the thread but doesn't send the reply back
  // through the bridge. Useful for read-only / observer agents on group
  // chats where the user wants archival + LLM analysis but no automatic
  // posting.
  if (!names.has("never_reply")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN never_reply INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * `silent_mode` is per-route, not per-agent: the same agent can auto-reply
 * in one chat and stay observer-only in another. Backfills from the legacy
 * per-agent `never_reply` flag on first migration so behavior is preserved
 * for existing installs. After backfill, `never_reply` is no longer read by
 * the dispatcher — the route flag is canonical.
 */
function ensureBridgeRouteColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(bridge_routes)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("silent_mode")) {
    db.exec("ALTER TABLE bridge_routes ADD COLUMN silent_mode INTEGER NOT NULL DEFAULT 0");
    // Best-effort backfill from the legacy per-agent flag if the column exists.
    const agentCols = db.prepare("PRAGMA table_info(agent_configs)").all() as Array<{ name: string }>;
    if (agentCols.some((c) => c.name === "never_reply")) {
      db.exec(`
        UPDATE bridge_routes
        SET silent_mode = 1
        WHERE agent_id IN (SELECT id FROM agent_configs WHERE never_reply = 1)
      `);
    }
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
    reanchorOrphanThreads(db);
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

  reanchorOrphanThreads(db);
}

// Threads have a UNIQUE(agent_id) index (one thread per agent), so we can't
// bulk-repoint orphan threads to a single fallback — that would violate the
// constraint as soon as there are 2+ orphans. Instead we drop orphan threads
// (and their messages); the agent they pointed at no longer exists.
function reanchorOrphanThreads(db: DatabaseSync): void {
  db.exec(`
    DELETE FROM messages WHERE thread_id IN (
      SELECT thread_id FROM threads WHERE agent_id NOT IN (SELECT id FROM agent_configs)
    )
  `);
  db.exec(`
    DELETE FROM threads WHERE agent_id NOT IN (SELECT id FROM agent_configs)
  `);
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
