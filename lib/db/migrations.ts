import { DatabaseSync } from "node:sqlite";
import { MBTI_PRESETS, type MbtiType } from "@/lib/agents/adaptive-persona-presets";

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
      adaptive_persona_enabled  INTEGER NOT NULL DEFAULT 0,
      adaptive_persona_strength INTEGER NOT NULL DEFAULT 50,
      adaptive_empathy          INTEGER NOT NULL DEFAULT 50,
      adaptive_expressiveness   INTEGER NOT NULL DEFAULT 50,
      adaptive_verbosity        INTEGER NOT NULL DEFAULT 50,
      adaptive_mbti            TEXT NOT NULL DEFAULT 'INTJ',
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
    -- Event-driven "watchers" (ADR-0027). A watcher polls one built-in
    -- tool with fixed args on an interval; when the tool's output changes
    -- (content hash != last_fingerprint) the agent is fired with
    -- {previous, current} as context. Until then the watcher consumes no
    -- LLM tokens — only the polled tool runs. Plugs into the trigger
    -- abstraction (ADR-0025) as a sibling handler to scheduled_task.
    CREATE TABLE IF NOT EXISTS watchers (
      id                TEXT PRIMARY KEY,
      agent_id          TEXT NOT NULL,
      label             TEXT NOT NULL,
      tool_name         TEXT NOT NULL,
      tool_args         TEXT NOT NULL DEFAULT '{}',  -- JSON
      interval_seconds  INTEGER NOT NULL,
      last_fingerprint  TEXT,                         -- sha256 of last tool result
      last_result       TEXT,                         -- raw tool result (string) for diff context
      last_run_at       TEXT,
      last_fired_at     TEXT,
      last_error        TEXT,
      next_run_at       TEXT NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 1,
      silent            INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watchers_due ON watchers(enabled, next_run_at);
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
      UNIQUE(agent_id)                                 -- one route per agent (catch-all may intentionally multiplex chats)
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_routes_bridge ON bridge_routes(bridge_id);
    -- HTTP/HTTPS proxy configuration (ADR-0009). Single-row table; the
    -- CHECK constraint enforces it. Non-secret fields are plaintext for
    -- diagnostics; password goes through lib/crypto/envelope.ts.
    CREATE TABLE IF NOT EXISTS proxy_config (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      mode        TEXT    NOT NULL CHECK (mode IN ('off', 'manual', 'system')),
      scheme      TEXT    NOT NULL DEFAULT 'http',         -- 'http' | 'https' (proxy hop scheme, ADR-0012)
      host        TEXT,
      port        INTEGER,
      username    TEXT,
      password    TEXT,                                    -- envelope-encrypted (enc:v1:…)
      no_proxy    TEXT,
      ca_bundle   TEXT,                                    -- PEM, plaintext (public cert, ADR-0012)
      updated_at  TEXT    NOT NULL
    );
    -- Document RAG (ADR-0024). A document_sources row is a folder the
    -- user asked Jarela to index for semantic search. Walked on each
    -- scheduler tick (cheap stat()); files whose mtime/size changed get
    -- re-chunked and re-embedded. documents_search exposes recall over
    -- the resulting chunks as an agent tool.
    CREATE TABLE IF NOT EXISTS document_sources (
      id              TEXT PRIMARY KEY,
      path            TEXT NOT NULL,
      label           TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      last_scan_at    TEXT,
      last_error      TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      UNIQUE(path)
    );
    CREATE TABLE IF NOT EXISTS documents (
      id              TEXT PRIMARY KEY,
      source_id       TEXT NOT NULL REFERENCES document_sources(id) ON DELETE CASCADE,
      path            TEXT NOT NULL,
      rel_path        TEXT NOT NULL,
      mtime_ms        INTEGER NOT NULL,
      size_bytes      INTEGER NOT NULL,
      content_hash    TEXT NOT NULL,
      last_indexed_at TEXT NOT NULL,
      chunk_count     INTEGER NOT NULL DEFAULT 0,
      UNIQUE(source_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id);
    CREATE TABLE IF NOT EXISTS document_chunks (
      id              TEXT PRIMARY KEY,
      document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index     INTEGER NOT NULL,
      text            TEXT NOT NULL,
      start_offset    INTEGER NOT NULL,
      end_offset      INTEGER NOT NULL,
      embedding       TEXT,
      UNIQUE(document_id, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id);
    -- Generic change-tracker primitive (ADR-0025). Lets any subsystem ask
    -- "has (scope, key) changed since we last looked?" by recording a
    -- fingerprint (e.g. content hash, mtime+size, etag) per key. Future
    -- triggers (fs_watch, tool_call dedupe) use it; the document indexer
    -- in lib/documents will migrate onto it in a later PR.
    CREATE TABLE IF NOT EXISTS change_tracker (
      scope        TEXT NOT NULL,
      key          TEXT NOT NULL,
      fingerprint  TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    );
    -- Built-in tool category toggles. Missing row = enabled (default-on).
    -- Disabled categories are filtered out at every tool-list surface so
    -- they vanish from the agent permission UI AND cannot be invoked even
    -- if an old agent config still references one of their tools.
    CREATE TABLE IF NOT EXISTS builtin_tool_categories (
      category   TEXT PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
  `);
  ensureBridgeRouteColumns(db);
  ensureAgentConfigColumns(db);
  ensureTaskAssignmentColumns(db);
  ensureEmbeddingColumns(db);
  ensureUserProfileLocationColumns(db);
  ensureProxyConfigSchemeAndCaBundle(db);
  ensureThreadsAgentIdUnique(db);
  ensureMessagesCategoryColumn(db);
  ensureScheduledTasksSilentColumn(db);
  ensureAgentDisplayFiltersColumn(db);
  ensureDocumentSourceRemoteColumns(db);
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

function ensureProxyConfigSchemeAndCaBundle(db: DatabaseSync): void {
  // ADR-0012. Adds scheme (http|https for the proxy hop) and ca_bundle
  // (PEM for proxies that MITM TLS with an internal CA). CA bundle is a
  // public cert and stored plaintext; password remains envelope-wrapped.
  const cols = db.prepare("PRAGMA table_info(proxy_config)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("scheme"))    db.exec("ALTER TABLE proxy_config ADD COLUMN scheme TEXT NOT NULL DEFAULT 'http'");
  if (!names.has("ca_bundle")) db.exec("ALTER TABLE proxy_config ADD COLUMN ca_bundle TEXT");
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
  // Persona preset (home/work/dev/custom). Drives the Credentials panel's
  // category filter so a home user doesn't see Jira / infrastructure
  // sections, and a work user doesn't see noise outside the work
  // toolbelt. NULL = unset (treat as "custom" → show everything). Set
  // by the Profile editor; consumed by IntegrationsPanel.
  if (!names.has("preset"))               db.exec("ALTER TABLE user_profile ADD COLUMN preset TEXT");
}

// Per-message classification. NULL/empty = ordinary chat content. Known
// non-null values surface as filterable groups in the chat panel so users
// can hide scheduled-task firings, bridge traffic, or synthetic page-capture
// uploads without losing the audit trail. Current categories:
//   'scheduled_task' - scheduler-injected prompt + its assistant reply
//   'bridge'         - bridge-mediated user inbound + assistant outbound
//   'synthetic'      - page-capture / file-upload generated user messages
function ensureMessagesCategoryColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "category")) {
    db.exec("ALTER TABLE messages ADD COLUMN category TEXT");
  }
}

// Per-task "silent" mode. When 1 the scheduler injects the prompt as a
// hidden user message and instructs the agent to reply only when there is
// something worth showing — otherwise the assistant turn is persisted
// hidden too (or skipped entirely).
function ensureScheduledTasksSilentColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "silent")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN silent INTEGER NOT NULL DEFAULT 0");
  }
}

// Per-agent message-channel display filters (ADR-0022). JSON blob:
//   { "thinking": true, "tool_use": true, "scheduled_task": true,
//     "bridge": true, "synthetic": true }
// NULL = inherit defaults (all-on). Missing keys also default to true so
// new channels added in future builds stay visible for existing users.
function ensureAgentDisplayFiltersColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(agent_configs)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "display_filters")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN display_filters TEXT");
  }
}

// ADR-0026 — remote document-RAG sources (Jira / Confluence). Extends the
// ADR-0024 document_sources table with a discriminator + JSON config so a
// single store + indexer dispatcher serves both local folders and remote
// content. Existing rows are 'local_folder' (matches pre-0026 behavior).
function ensureDocumentSourceRemoteColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(document_sources)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("kind")) {
    db.exec(
      "ALTER TABLE document_sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'local_folder'",
    );
  }
  if (!names.has("config")) {
    // JSON-encoded per-kind config (e.g. {"space_key":"ENG"} for
    // confluence_space, {"jql":"..."} for jira_jql). NULL for local_folder.
    db.exec("ALTER TABLE document_sources ADD COLUMN config TEXT");
  }
  if (!names.has("last_cursor")) {
    // Per-source incremental cursor (e.g. max external `updated` ISO
    // timestamp for Jira/Confluence). Lets remote indexers run cheaply
    // after the first full sync. NULL for local_folder.
    db.exec("ALTER TABLE document_sources ADD COLUMN last_cursor TEXT");
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
  // never_reply: when 1, the dispatcher records the inbound message and
  // the agent's response in the thread but doesn't send the reply back
  // through the bridge. Useful for read-only / observer agents on group
  // chats where the user wants archival + LLM analysis but no automatic
  // posting.
  if (!names.has("never_reply")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN never_reply INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("adaptive_persona_enabled")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN adaptive_persona_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("adaptive_persona_strength")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN adaptive_persona_strength INTEGER NOT NULL DEFAULT 50");
  }
  if (!names.has("adaptive_empathy")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN adaptive_empathy INTEGER NOT NULL DEFAULT 50");
  }
  if (!names.has("adaptive_expressiveness")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN adaptive_expressiveness INTEGER NOT NULL DEFAULT 50");
  }
  if (!names.has("adaptive_verbosity")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN adaptive_verbosity INTEGER NOT NULL DEFAULT 50");
  }
  if (!names.has("adaptive_mbti")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN adaptive_mbti TEXT NOT NULL DEFAULT 'INTJ'");
  }
  // Per-agent voice config. When voice_enabled=0 the chat UI hides the
  // mic + play controls for this agent entirely; STT/TTS endpoints reject
  // requests targeting it. Provider/model/voice are TTS-side; stt_model is
  // STT-side. Defaults pick Gemini flash-tier so a fresh agent with voice
  // turned on works against the existing "google" integration api_key.
  if (!names.has("voice_enabled")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN voice_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("voice_model")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN voice_model TEXT NOT NULL DEFAULT 'gemini-2.5-flash-preview-tts'");
  }
  if (!names.has("voice_name")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN voice_name TEXT NOT NULL DEFAULT 'Kore'");
  }
  if (!names.has("voice_stt_model")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN voice_stt_model TEXT NOT NULL DEFAULT 'gemini-2.5-flash'");
  }
  if (!names.has("voice_auto_speak")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN voice_auto_speak INTEGER NOT NULL DEFAULT 1");
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
    `INSERT OR IGNORE INTO agent_configs (
      id, name, icon, identity, instructions, tools, model_config_name, is_default,
      never_reply,
      adaptive_persona_enabled, adaptive_persona_strength, adaptive_empathy, adaptive_expressiveness, adaptive_verbosity, adaptive_mbti,
      created_at, updated_at
    )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const p of BASE_AGENT_PROFILES) {
    const preset = MBTI_PRESETS[p.mbti];
    insert.run(
      p.id,
      p.name,
      p.icon ?? null,
      p.identity,
      p.instructions,
      JSON.stringify(p.tools),
      null,
      p.is_default ? 1 : 0,
      p.never_reply ? 1 : 0,
      p.adaptive ? 1 : 0,
      preset.strength,
      preset.empathy,
      preset.expressiveness,
      preset.verbosity,
      p.mbti,
      t,
      t,
    );
  }

  reanchorOrphanThreads(db);
}

interface BaseAgentProfile {
  id: string;
  name: string;
  icon?: string | null;
  identity: string;
  instructions: string;
  tools: string[];
  mbti: MbtiType;
  adaptive: boolean;
  is_default?: boolean;
  // When true, the agent runs on bridge/scheduled input but does not
  // auto-send replies — it observes and records, only speaking when the
  // user directly addresses it (see lib/bridges/dispatcher.ts).
  never_reply?: boolean;
}

// Starter profiles shipped on first run. The user can edit, disable, or
// delete any of them — once they have any agents we stop re-seeding (see
// the guard at the top of seedAgentConfigs), so user choices are sticky.
//
// Each profile pre-binds a small, focused tool set so the agent is useful
// out of the box without exposing every capability by default. Tools that
// require integrations (gmail/outlook/calendar) are wired up but will
// surface a setup hint at call time if the integration is not configured.
const BASE_AGENT_PROFILES: BaseAgentProfile[] = [
  {
    id: "assistant",
    name: "Assistant",
    identity: "You are a helpful general-purpose assistant.",
    instructions:
      "Answer concisely. Ask for clarification only when truly ambiguous. When you don't know something, say so instead of guessing.",
    tools: [],
    mbti: "INTJ",
    adaptive: false,
    is_default: true,
  },
  {
    id: "researcher",
    name: "Researcher",
    identity:
      "You are a careful researcher who finds, cross-checks, and summarizes information from the web.",
    instructions:
      "Use web_search to discover sources and web_fetch to read them. Prefer primary sources over aggregators. Cite URLs inline. When findings conflict, surface the disagreement instead of picking a side. Save durable facts with memory_write so future sessions can build on them.",
    tools: ["web_search", "web_fetch", "memory_read", "memory_write", "memory_list"],
    mbti: "INTP",
    adaptive: true,
  },
  {
    id: "developer",
    name: "Developer",
    identity:
      "You are a pragmatic software engineer working in the user's local repo with a real build/test harness.",
    instructions:
      "Read before you write. Use file_list / file_read / file_stat to map the code, then file_edit for surgical changes and file_write only for new files. After every meaningful edit, run the project's build, lint, or test command via shell_exec (or local_exec for a single binary) and read the output before declaring success — never claim a fix without proof. Use github_* to look up issues/PRs for context. Prefer the smallest change that solves the problem; never invent paths or APIs.",
    tools: [
      "file_read",
      "file_write",
      "file_edit",
      "file_list",
      "file_stat",
      "file_mkdir",
      "file_move",
      "file_copy",
      "file_delete",
      "local_exec",
      "shell_exec",
      "web_fetch",
      "web_search",
      "github_search_issues",
      "github_get_issue",
      "github_list_pulls",
      "github_get_pull",
      "github_get_repo",
      "memory_read",
      "memory_write",
      "memory_list",
    ],
    mbti: "INTJ",
    adaptive: true,
  },
  {
    id: "planner",
    name: "Planner",
    identity:
      "You are a planning partner who turns vague intentions into concrete, scheduled actions.",
    instructions:
      "When the user describes something they want to happen later or recurrently, propose a schedule_task with a clear prompt and a cron or ISO schedule, then confirm before creating it. Use list_scheduled_tasks before adding to avoid duplicates. Keep memory_write notes on the user's recurring goals so plans stay aligned over time.",
    tools: [
      "schedule_task",
      "list_scheduled_tasks",
      "cancel_scheduled_task",
      "memory_read",
      "memory_write",
      "memory_list",
    ],
    mbti: "ENTJ",
    adaptive: true,
  },
  {
    id: "inbox",
    name: "Inbox Triage",
    identity:
      "You help triage email and calendar. You summarize, draft, and surface what actually needs attention.",
    instructions:
      "When asked about mail, search first, then read the specific message before drafting. Drafts are created — never sent automatically. For calendar requests, list the relevant window before creating events. If an integration is not configured, tell the user which one and stop.",
    tools: [
      "gmail_search",
      "gmail_get_message",
      "gmail_create_draft",
      "outlook_search",
      "outlook_get_message",
      "outlook_create_draft",
      "calendar_list_events",
      "calendar_create_event",
      "outlook_calendar_list_events",
      "outlook_calendar_create_event",
    ],
    mbti: "ESFJ",
    adaptive: true,
  },
  {
    id: "companion",
    name: "Companion",
    identity:
      "You are a reflective companion for journaling and thinking out loud.",
    instructions:
      "Listen more than you advise. Ask one open question at a time. Mirror back themes you notice across sessions; use memory_read at the start of a thread and memory_write to record durable insights (values, ongoing struggles, wins), never raw content.",
    tools: ["memory_read", "memory_write", "memory_list"],
    mbti: "INFJ",
    adaptive: true,
  },

  // Backward-compat: pre-migration threads used agent_id="llm" or "echo".
  // Kept so historical threads still resolve to a real agent_configs row.
  {
    id: "llm",
    name: "LLM Agent",
    identity: "You are a helpful assistant.",
    instructions: "",
    tools: [],
    mbti: "INTJ",
    adaptive: false,
  },
  {
    id: "echo",
    name: "Echo",
    identity: "",
    instructions: "",
    tools: [],
    mbti: "INTJ",
    adaptive: false,
  },
];

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
