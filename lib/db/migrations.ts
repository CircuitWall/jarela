import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { writeFileSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MBTI_PRESETS, type MbtiType } from "@/lib/agents/adaptive-persona-presets";
import { encrypt, decryptIfNeeded } from "@/lib/crypto/envelope";
import { FILES_DIR, isSafeFileName } from "@/lib/files";

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
      id                   TEXT PRIMARY KEY,
      agent_id             TEXT NOT NULL,
      prompt               TEXT NOT NULL,
      description          TEXT,
      kind                 TEXT NOT NULL,
      schedule             TEXT NOT NULL,
      next_run_at          TEXT NOT NULL,
      last_run_at          TEXT,
      last_error           TEXT,
      enabled              INTEGER NOT NULL DEFAULT 1,
      silent               INTEGER NOT NULL DEFAULT 0,
      reaction_kind        TEXT NOT NULL DEFAULT 'agent_prompt',  -- ADR-0032
      reaction_script      TEXT,                                  -- ADR-0032
      reaction_script_args TEXT,                                  -- ADR-0032
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
    -- Event-driven "watchers" (ADR-0027). A watcher polls one built-in
    -- tool with fixed args on an interval; when the tool's output changes
    -- (content hash != last_fingerprint) the agent is fired with
    -- {previous, current} as context. Until then the watcher consumes no
    -- LLM tokens Ã¢â‚¬â€ only the polled tool runs. Plugs into the trigger
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
      reaction_prompt   TEXT,                          -- ADR-0030: NULL = default directive
      reaction_kind     TEXT NOT NULL DEFAULT 'agent_prompt',  -- ADR-0031: 'agent_prompt' | 'script'
      reaction_script       TEXT,                       -- ADR-0031: registry key, only when kind='script'
      reaction_script_args  TEXT,                       -- ADR-0031: JSON object, only when kind='script'
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
    -- Per-bridge chat blocklist. When a catch-all route (remote_jid='*')
    -- is in place, every otherwise-unrouted inbound message fires the
    -- catch-all agent. An entry here short-circuits the router to NULL
    -- BEFORE the catch-all is consulted, so messages from the listed
    -- chats never enter any agent thread, never trigger tools, and never
    -- write to memory. Independent of routes: a chat can be ignored even
    -- without any route existing (the entry just makes it explicit).
    CREATE TABLE IF NOT EXISTS bridge_ignores (
      id          TEXT PRIMARY KEY,
      bridge_id   TEXT NOT NULL,
      remote_jid  TEXT NOT NULL,                       -- e.g. 5511...@s.whatsapp.net or ...@g.us or ...@lid
      label       TEXT,                                -- user-visible name captured at add time
      created_at  TEXT NOT NULL,
      UNIQUE(bridge_id, remote_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_ignores_bridge ON bridge_ignores(bridge_id);
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
      password    TEXT,                                    -- envelope-encrypted (enc:v1:Ã¢â‚¬Â¦)
      no_proxy    TEXT,
      ca_bundle   TEXT,                                    -- PEM, plaintext (public cert, ADR-0012)
      updated_at  TEXT    NOT NULL
    );
    -- Sites the agent can use as the user. The user grants approval once
    -- (Settings panel or in-browser dialog). The single approval enables
    -- both browser-RPC navigation (the extension drives a tab on this
    -- host) and cookie passthrough (cookies the extension scrapes get
    -- attached to web_fetch requests for this host). The two capabilities
    -- intentionally share one row: removing the host instantly disables
    -- both.
    CREATE TABLE IF NOT EXISTS allowed_sites (
      hostname            TEXT PRIMARY KEY,                 -- exact host, lowercased; suffix match handled in code
      ssrf_bypass         INTEGER NOT NULL DEFAULT 0,       -- 1 = let web_fetch reach private/loopback addresses for this host
      cookies_blob        TEXT,                             -- envelope-encrypted "name=value; Ã¢â‚¬Â¦"; NULL until extension first PUTs cookies
      created_at          TEXT NOT NULL,
      last_used_at        TEXT,
      cookies_updated_at  TEXT
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
    -- Default LangChain packages disabled by the operator.
    -- Missing row = enabled (default-on). See lib/tools/default-packages.ts
    -- for the in-tree set; lib/stores/disabled-packages.ts is the only
    -- writer.
    CREATE TABLE IF NOT EXISTS disabled_packages (
      id         TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL
    );
    -- Aggregated per-tool telemetry used to rank/filter tools in the UI.
    -- used_count is heuristic: a successful result whose payload appears to
    -- feed the assistant's final response for that turn.
    CREATE TABLE IF NOT EXISTS tool_stats (
      tool_name      TEXT PRIMARY KEY,
      call_count     INTEGER NOT NULL DEFAULT 0,
      success_count  INTEGER NOT NULL DEFAULT 0,
      error_count    INTEGER NOT NULL DEFAULT 0,
      used_count     INTEGER NOT NULL DEFAULT 0,
      last_called_at TEXT,
      updated_at     TEXT NOT NULL
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
  ensureMessagesMetadataColumn(db);
  ensureScheduledTasksSilentColumn(db);
  ensureAgentDisplayFiltersColumn(db);
  ensureDocumentSourceRemoteColumns(db);
  ensureWatchersReactionPromptColumn(db);
  ensureWatchersReactionKindColumns(db);
  ensureScheduledTasksReactionKindColumns(db);
  ensureMessageUsageTable(db);
  ensureMessageUsageTierColumns(db);
  ensureMessageUsageCacheColumns(db);
  ensureThreadContextPinColumns(db);
  ensureThreadChannelSummariesTable(db);
  ensureCredentialsTable(db);
  ensureCredentialsLabelAndDefaultColumns(db);
  ensureModelConfigCredentialIdColumn(db);
  ensureAgentConfigsToolCredentialsColumn(db);
  seedAgentConfigs(db);
  backfillDeveloperInteractiveTerminalTools(db);
  migrateInlineApiKeysToCredentials(db);
  migrateIntegrationsToCredentials(db);
  migrateICloudPackageIds(db);
  spillLegacyImageAttachments(db);
}

// iCloud used to register as a single default package (id: "icloud") under
// a dedicated "iCloud" tool category. It now ships as three descriptors
// ("icloud_mail", "icloud_calendar", "icloud_tasks") that fold into the
// Mail / Calendar / Tasks categories alongside Gmail / Outlook / MS
// To-Do. Preserve the operator's disable intent across the rename:
//   - If `disabled_packages` had `icloud`, expand it into all three
//     new ids so the same tools stay hidden.
//   - If `builtin_tool_categories` had `iCloud` disabled, translate that
//     to disabling all three package ids (there is no per-category dial
//     for iCloud any more; hiding the packages is the equivalent).
// Idempotent Ã¢â‚¬â€ safe to run on every boot.
function migrateICloudPackageIds(db: DatabaseSync): void {
  const nowIso = now();
  const newIds = ["icloud_mail", "icloud_calendar", "icloud_tasks"] as const;

  const legacyDisabled = db
    .prepare("SELECT 1 FROM disabled_packages WHERE id='icloud'")
    .get() as { 1?: number } | undefined;
  if (legacyDisabled) {
    const insert = db.prepare(
      `INSERT INTO disabled_packages (id, updated_at) VALUES (?, ?)
       ON CONFLICT(id) DO NOTHING`,
    );
    for (const id of newIds) insert.run(id, nowIso);
    db.prepare("DELETE FROM disabled_packages WHERE id='icloud'").run();
  }

  const legacyCategory = db
    .prepare("SELECT enabled FROM builtin_tool_categories WHERE category='iCloud'")
    .get() as { enabled?: number } | undefined;
  if (legacyCategory) {
    if (legacyCategory.enabled === 0) {
      const insert = db.prepare(
        `INSERT INTO disabled_packages (id, updated_at) VALUES (?, ?)
         ON CONFLICT(id) DO NOTHING`,
      );
      for (const id of newIds) insert.run(id, nowIso);
    }
    db.prepare("DELETE FROM builtin_tool_categories WHERE category='iCloud'").run();
  }
}

// Multi-instance credentials per (type, provider). `label` is a
// human-readable name shown in the UI ("Work", "Personal", Ã¢â‚¬Â¦); `is_default`
// picks one row per (type, provider) as the implicit pick for callers that
// don't reference a specific id (back-compat with the old "first row wins"
// behaviour). The first row created for a given (type, provider) is
// promoted to default automatically by the store layer.
function ensureCredentialsLabelAndDefaultColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(credentials)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("label")) {
    db.exec("ALTER TABLE credentials ADD COLUMN label TEXT");
    // One-shot backfill of pre-existing rows so the panel Ã¢â‚¬â€ which now
    // only renders configured rows by their name Ã¢â‚¬â€ never displays a
    // blank entry for legacy single-credential installs. MUST stay
    // gated on the ADD COLUMN above; running this on every boot would
    // clobber second-of-pair rows that the store layer intentionally
    // leaves NULL.
    db.exec("UPDATE credentials SET label='Default' WHERE label IS NULL");
  }
  if (!names.has("is_default")) {
    db.exec("ALTER TABLE credentials ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0");
    // Promote the first-by-id row per (type, provider) to default so the
    // "first wins" resolution that ran before this column existed keeps
    // picking the same credential.
    db.exec(`
      UPDATE credentials SET is_default=1
      WHERE id IN (
        SELECT MIN(id) FROM credentials GROUP BY type, provider
      )
    `);
  }
}

// Per-agent override of which credential each tool uses when more than
// one is configured for the tool's integration. JSON object shaped like
// `{ "<toolName>": "<credentialId>" }`. Missing tools / NULL column fall
// back to the integration's default credential (see is_default above).
function ensureAgentConfigsToolCredentialsColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(agent_configs)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "tool_credentials")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN tool_credentials TEXT");
  }
}

// ADR-0044. Per-channel warm summary so a thread shared across `chat`,
// `scheduled_task`, `watcher`, and `bridge` channels stops blending
// automation history into interactive turns. Replaces the single
// `threads.warm_summary` blob Ã¢â‚¬â€ which is kept one release as a
// read-only fallback Ã¢â‚¬â€ with one row per (thread_id, channel).
function ensureThreadChannelSummariesTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_channel_summaries (
      thread_id       TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      channel         TEXT NOT NULL,
      summary         TEXT NOT NULL,
      summary_before  TEXT,
      computed_at     TEXT NOT NULL,
      PRIMARY KEY (thread_id, channel)
    );
    CREATE INDEX IF NOT EXISTS idx_thread_channel_summaries_thread ON thread_channel_summaries(thread_id);
  `);
}

// ADR-0041. Immutable per-assistant-turn snapshot of LLM usage. Written once
// alongside addMessage(...,"assistant",...) and never updated, so the
// dashboard's token/$ aggregates are not retroactively rewritten when the
// user reassigns an agent's model, renames a model config, or refreshes
// pricing. See docs/adr/0041-immutable-message-usage.md.
function ensureMessageUsageTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_usage (
      message_id               TEXT PRIMARY KEY,
      thread_id                TEXT NOT NULL,
      agent_id                 TEXT NOT NULL,
      agent_name               TEXT NOT NULL,
      provider                 TEXT NOT NULL,
      model_id                 TEXT NOT NULL,
      model_config_name        TEXT,
      input_tokens             INTEGER NOT NULL,
      output_tokens            INTEGER NOT NULL,
      input_rate_usd_per_mtok  REAL,
      output_rate_usd_per_mtok REAL,
      cost_usd                 REAL NOT NULL,
      created_at               TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_message_usage_created_at ON message_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_message_usage_agent_id   ON message_usage(agent_id);
  `);
}

function ensureEmbeddingColumns(db: DatabaseSync): void {  // Embeddings stored as JSON-encoded float[] in TEXT to keep migration simple.
  // For the corpus sizes we expect (thousands of rows), in-memory cosine
  // similarity in JS is fast enough Ã¢â‚¬â€ no need for sqlite-vec or duckdb yet.
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
    // same way it renders live ones Ã¢â‚¬â€ instead of only the *Ã¢â‚¬â€ used: x* footer
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
  // explicit opt-in flag Ã¢â‚¬â€ when 0 the client must NOT post coordinates
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
  // toolbelt. NULL = unset (treat as "custom" Ã¢â€ â€™ show everything). Set
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

// Per-message auxiliary metadata (JSON object). NULL on legacy rows and on
// rows that don't carry any extra data. Current consumer is the citation
// checker (`citation_strictness` != 'off'), which attaches a verdict shaped like
// `{ citations: { claims: [...], unverified: [...] } }`. Adding more keys
// later is free Ã¢â‚¬â€ readers tolerate unknown fields.
function ensureMessagesMetadataColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "metadata")) {
    db.exec("ALTER TABLE messages ADD COLUMN metadata TEXT");
  }
}

// ADR-0030 Ã¢â‚¬â€ per-watcher reaction prompt. NULL = use the default
// "summarise the diff" directive baked into buildFiringPrompt. Non-null =
// substitute that text in place of the default; the diff envelope (label,
// tool, args, previous, current) is unchanged.
function ensureWatchersReactionPromptColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(watchers)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "reaction_prompt")) {
    db.exec("ALTER TABLE watchers ADD COLUMN reaction_prompt TEXT");
  }
}

// ADR-0031 Ã¢â‚¬â€ script-backed watcher reactions. Adds three nullable columns
// to the watchers table:
//   reaction_kind         'agent_prompt' (default) | 'script'
//   reaction_script       registry key, only when kind='script'
//   reaction_script_args  JSON object, only when kind='script'
// Existing rows get reaction_kind='agent_prompt' and continue to behave
// identically (the agent runs against the diff, optionally guided by
// ADR-0030's reaction_prompt).
function ensureWatchersReactionKindColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(watchers)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("reaction_kind")) {
    db.exec(
      "ALTER TABLE watchers ADD COLUMN reaction_kind TEXT NOT NULL DEFAULT 'agent_prompt'",
    );
  }
  if (!names.has("reaction_script")) {
    db.exec("ALTER TABLE watchers ADD COLUMN reaction_script TEXT");
  }
  if (!names.has("reaction_script_args")) {
    db.exec("ALTER TABLE watchers ADD COLUMN reaction_script_args TEXT");
  }
}

// Per-task "silent" mode. When 1 the scheduler injects the prompt as a
// hidden user message and instructs the agent to reply only when there is
// something worth showing Ã¢â‚¬â€ otherwise the assistant turn is persisted
// hidden too (or skipped entirely).
function ensureScheduledTasksSilentColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "silent")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN silent INTEGER NOT NULL DEFAULT 0");
  }
}

// ADR-0032 Ã¢â‚¬â€ script-backed scheduled tasks. Mirrors the watcher migration
// in ensureWatchersReactionKindColumns. Adds:
//   reaction_kind         'agent_prompt' (default) | 'script'
//   reaction_script       registry key, only when kind='script'
//   reaction_script_args  JSON object, only when kind='script'
// Existing rows take reaction_kind='agent_prompt' (column default) and
// continue to fire the agent with the saved prompt as before.
function ensureScheduledTasksReactionKindColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("reaction_kind")) {
    db.exec(
      "ALTER TABLE scheduled_tasks ADD COLUMN reaction_kind TEXT NOT NULL DEFAULT 'agent_prompt'",
    );
  }
  if (!names.has("reaction_script")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN reaction_script TEXT");
  }
  if (!names.has("reaction_script_args")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN reaction_script_args TEXT");
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

// ADR-0026 Ã¢â‚¬â€ remote document-RAG sources (Jira / Confluence / mail). Extends the
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
    // confluence_space, {"jql":"..."} for jira_jql, {"query":"is:unread"}
    // for gmail_mail). NULL for local_folder.
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
  // Check if index already exists Ã¢â‚¬â€ skip if so
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
  // ADR-0033 Ã¢â‚¬â€ per-agent harness override. NULL = inherit the global default
  // harness (app-settings.default_harness_id, which itself defaults to
  // 'builtin:default'). Non-null is either a builtin id ("builtin:default")
  // or a user-created custom id ("custom:<uuid>").
  if (!names.has("harness_id")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN harness_id TEXT");
  }
  // Per-agent delegation whitelist (JSON array of agent ids). NULL or empty
  // array means the agent cannot delegate. Read by lib/tools/delegate.ts to
  // gate the delegate_to_agent tool.
  if (!names.has("delegate_targets")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN delegate_targets TEXT");
  }
  // ADR-0043 Ã¢â‚¬â€ per-agent override of context_tier_proportions. JSON-encoded
  // `{ hot, warm, facts }` (any positive numbers Ã¢â‚¬â€ `normalizeTierProportions`
  // divides by sum, so the UI can ship raw weights instead of demanding
  // sum=100 from the user). NULL = inherit from the model config.
  if (!names.has("context_tier_proportions")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN context_tier_proportions TEXT");
  }
  // Per-agent override of the anti-hallucination classifier (ADR-Ã¢â‚¬Â¦). NULL
  // on either column = inherit the global JARELA_HALLUCINATION_DETECTOR_*
  // env knob. Mode is one of "off" | "report" | "enforce"; model_config is
  // the name of a saved model config (lib/stores/model-config) used as
  // the classifier model.
  if (!names.has("anti_hallucination_mode")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN anti_hallucination_mode TEXT");
  }
  if (!names.has("anti_hallucination_model_config")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN anti_hallucination_model_config TEXT");
  }
  // Independent of the stall classifier: when 1, the agent's system prompt
  // gets a citation-link directive and the assistant turn is post-checked
  // for {source link present, source previously visited in this thread}.
  // Reuses `anti_hallucination_model_config` as the checker model.
  if (!names.has("require_source_links")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN require_source_links INTEGER NOT NULL DEFAULT 0");
  }
  // Replaces the boolean require_source_links with a 4-level strictness
  // enum: 'off' | 'informational' | 'standard' | 'strict'.
  //   off           Ã¢â‚¬â€ no checker, no directive (legacy require_source_links=0)
  //   informational Ã¢â‚¬â€ checker runs; agent NOT asked to cite (UI surfaces refs)
  //   standard      Ã¢â‚¬â€ agent nudged to cite KEY claims (legacy require_source_links=1)
  //   strict        Ã¢â‚¬â€ agent must cite EVERY factual claim AND stall classifier
  //                   is forced to mode='model'
  if (!names.has("citation_strictness")) {
    db.exec("ALTER TABLE agent_configs ADD COLUMN citation_strictness TEXT NOT NULL DEFAULT 'off'");
    // Backfill from the legacy boolean so existing agents keep their behavior.
    db.exec("UPDATE agent_configs SET citation_strictness = 'standard' WHERE require_source_links = 1");
  }
}

/**
 * `silent_mode` is per-route, not per-agent: the same agent can auto-reply
 * in one chat and stay observer-only in another. Backfills from the legacy
 * per-agent `never_reply` flag on first migration so behavior is preserved
 * for existing installs. After backfill, `never_reply` is no longer read by
 * the dispatcher Ã¢â‚¬â€ the route flag is canonical.
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
  // Per-route reply trigger: which sender role unlocks an outbound reply.
  // 'counterpart' (default) = agent answers the user's chat partner / group
  // members but stays quiet when the user themselves types Ã¢â‚¬â€ the typical
  // "auto-responder on my behalf" use case. 'user' = agent only reacts to
  // the user's own messages (e.g. expand/translate-my-draft assistants).
  // silent_mode (above) overrides this Ã¢â‚¬â€ when set, nothing goes out
  // regardless of role match.
  if (!names.has("respond_to")) {
    db.exec("ALTER TABLE bridge_routes ADD COLUMN respond_to TEXT NOT NULL DEFAULT 'counterpart'");
  }
  // Per-route catch-up watermark. Stores the messageTimestamp (epoch ms) of
  // the most recent inbound delivered to the agent. On reconnect, the
  // adapter accepts both `notify` (live) and `append` (server-replayed
  // backlog) upserts and uses this watermark to skip anything we already
  // processed. NULL on legacy rows / brand-new routes => no skip.
  if (!names.has("last_seen_ts")) {
    db.exec("ALTER TABLE bridge_routes ADD COLUMN last_seen_ts INTEGER");
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

// ADR-0042 Ã¢â‚¬â€ explicit per-thread context pin + persisted warm summary.
// hot_since: ISO timestamp of the boundary the user has chosen to include in
//   the agent's hot context. NULL = no explicit pin Ã¢â€ â€™ buildHistoryWindow falls
//   back to the agent's history_window_hours default.
// warm_summary: latest LLM-summarised recap of messages older than
//   warm_summary_before. The chat UI renders this as an inline card above the
//   boundary divider so the user can see what the agent had to compress.
// warm_summary_before: the boundary the cached summary covers. The summary is
//   considered fresh only when warm_summary_before === hot_since; otherwise
//   the next run will re-summarise and overwrite both.
function ensureThreadContextPinColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("hot_since"))               db.exec("ALTER TABLE threads ADD COLUMN hot_since TEXT");
  if (!names.has("warm_summary"))            db.exec("ALTER TABLE threads ADD COLUMN warm_summary TEXT");
  if (!names.has("warm_summary_before"))     db.exec("ALTER TABLE threads ADD COLUMN warm_summary_before TEXT");
  if (!names.has("warm_summary_computed_at")) db.exec("ALTER TABLE threads ADD COLUMN warm_summary_computed_at TEXT");
  // Compaction stats Ã¢â‚¬â€ message count + original transcript char count of the
  // material that fed `warm_summary`. The chat UI displays them on the
  // boundary chip so the user can see how much was compressed and by how
  // much. NULL on legacy rows / rows summarised before these columns existed.
  if (!names.has("warm_summary_source_messages")) db.exec("ALTER TABLE threads ADD COLUMN warm_summary_source_messages INTEGER");
  if (!names.has("warm_summary_source_chars"))    db.exec("ALTER TABLE threads ADD COLUMN warm_summary_source_chars INTEGER");
}

// Per-tier input-token breakdown so the chat UI can show actual
// hot/warm/facts/overhead consumption per turn (not just the proportional
// budget). All eight columns are nullable so legacy rows simply render an
// "unknown" bar. Re-derivation isn't possible after the fact (the
// history-window state isn't preserved), so backfill is intentionally NULL.
function ensureMessageUsageTierColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(message_usage)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("hot_tokens"))            db.exec("ALTER TABLE message_usage ADD COLUMN hot_tokens INTEGER");
  if (!names.has("warm_tokens"))           db.exec("ALTER TABLE message_usage ADD COLUMN warm_tokens INTEGER");
  if (!names.has("facts_tokens"))          db.exec("ALTER TABLE message_usage ADD COLUMN facts_tokens INTEGER");
  if (!names.has("overhead_tokens"))       db.exec("ALTER TABLE message_usage ADD COLUMN overhead_tokens INTEGER");
  if (!names.has("hot_budget_tokens"))     db.exec("ALTER TABLE message_usage ADD COLUMN hot_budget_tokens INTEGER");
  if (!names.has("warm_budget_tokens"))    db.exec("ALTER TABLE message_usage ADD COLUMN warm_budget_tokens INTEGER");
  if (!names.has("facts_budget_tokens"))   db.exec("ALTER TABLE message_usage ADD COLUMN facts_budget_tokens INTEGER");
  if (!names.has("context_window_tokens")) db.exec("ALTER TABLE message_usage ADD COLUMN context_window_tokens INTEGER");
}

// PR #181 enabled Anthropic prompt caching, but the per-turn usage snapshot
// only captured `input_tokens` / `output_tokens`. Anthropic returns cache
// reads and writes as separate counts (priced at 0.1Ãƒâ€” and 1.25Ãƒâ€” the input
// rate respectively), so without these columns the dashboard underreports
// cost on cache-creating turns and *over*reports on cache-hitting turns.
// Both columns are nullable: legacy rows and non-Anthropic providers leave
// them NULL.
function ensureMessageUsageCacheColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(message_usage)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("cache_creation_input_tokens")) db.exec("ALTER TABLE message_usage ADD COLUMN cache_creation_input_tokens INTEGER");
  if (!names.has("cache_read_input_tokens"))     db.exec("ALTER TABLE message_usage ADD COLUMN cache_read_input_tokens INTEGER");
  if (!names.has("thinking_tokens"))             db.exec("ALTER TABLE message_usage ADD COLUMN thinking_tokens INTEGER");
}

function seedAgentConfigs(db: DatabaseSync): void {
  // Only seed on first run Ã¢â‚¬â€ once the user has any agents we must not
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

function backfillDeveloperInteractiveTerminalTools(db: DatabaseSync): void {
  const row = db.prepare("SELECT instructions, tools FROM agent_configs WHERE id='developer'").get() as { instructions: string; tools: string } | undefined;
  if (!row) return;

  let tools: string[] = [];
  try {
    const parsed = JSON.parse(row.tools);
    if (Array.isArray(parsed)) {
      tools = parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
    }
  } catch {
    tools = [];
  }

  const interactiveTools = [
    "terminal_open",
    "terminal_exec",
    "terminal_send",
    "terminal_read",
    "terminal_close",
    "terminal_list",
  ];
  const legacyTools = [
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
  ];
  const hasInteractiveTools = interactiveTools.every((tool) => tools.includes(tool));
  const isLegacyToolSet = tools.length === legacyTools.length && tools.every((tool, index) => tool === legacyTools[index]);
  const hasOldInstruction = row.instructions.includes("shell_exec (or local_exec for a single binary)");

  if (!hasOldInstruction && !isLegacyToolSet) return;

  const nextTools = hasInteractiveTools ? tools : Array.from(new Set([...tools, ...interactiveTools]));
  const nextInstructions = hasOldInstruction
    ? row.instructions.replace(
        "After every meaningful edit, run the project's build, lint, or test command via shell_exec (or local_exec for a single binary) and read the output before declaring success â€” never claim a fix without proof.",
        "After every meaningful edit, run the project's build, lint, or test command via terminal_open + terminal_exec + terminal_read when you need an interactive shell, or shell_exec / local_exec for a simple one-shot command, and read the output before declaring success â€” never claim a fix without proof.",
      )
    : row.instructions;

  db.prepare("UPDATE agent_configs SET instructions=?, tools=?, updated_at=? WHERE id='developer'").run(
    nextInstructions,
    JSON.stringify(nextTools),
    now(),
  );
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
  // auto-send replies Ã¢â‚¬â€ it observes and records, only speaking when the
  // user directly addresses it (see lib/bridges/dispatcher.ts).
  never_reply?: boolean;
}

// Starter profiles shipped on first run. The user can edit, disable, or
// delete any of them Ã¢â‚¬â€ once they have any agents we stop re-seeding (see
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
      "Read before you write. Use file_list / file_read / file_stat to map the code, then file_edit for surgical changes and file_write only for new files. After every meaningful edit, run the project's build, lint, or test command via terminal_open + terminal_exec + terminal_read when you need an interactive shell, or shell_exec / local_exec for a simple one-shot command, and read the output before declaring success Ã¢â‚¬â€ never claim a fix without proof. Use github_* to look up issues/PRs for context. Prefer the smallest change that solves the problem; never invent paths or APIs.",
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
      "terminal_open",
      "terminal_exec",
      "terminal_send",
      "terminal_read",
      "terminal_close",
      "terminal_list",
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
      "When asked about mail, search first, then read the specific message before drafting. Drafts are created Ã¢â‚¬â€ never sent automatically. For calendar requests, list the relevant window before creating events. If an integration is not configured, tell the user which one and stop.",
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
// bulk-repoint orphan threads to a single fallback Ã¢â‚¬â€ that would violate the
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

// First-class typed-credentials table. Replaces the per-row inline
// `api_key` / `base_url` / `extra_headers` blob inside `model_configs.params`
// and is intended to absorb the `integrations` store (OAuth + API keys for
// Gmail/Outlook/Google/Atlassian/GitHub) in a later migration without
// schema change.
//
//   id           Stable handle referenced by model_configs.credential_id
//                (and later other tables). Format: `<type>-<provider>`
//                with a `-N` collision bump.
//   type         Coarse domain bucket: `model` for LLM credentials, will
//                grow to `tts`, `integration`, Ã¢â‚¬Â¦
//   provider     Provider key within the type (e.g. `anthropic`,
//                `github-copilot`, later `gmail`, `outlook`).
//   auth_method  `api_key` | `oauth`. Drives the editor UI and the
//                resolver: `api_key` flattens straight into ProviderParams;
//                `oauth` holds tokens that the provider adapter exchanges
//                at call time.
//   params       Encrypted JSON. For `api_key`: { api_key, base_url?,
//                extra_headers? }. For `oauth`: { client_id, client_secret,
//                refresh_token, access_token?, expires_at? }.
function ensureCredentialsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      provider    TEXT NOT NULL,
      auth_method TEXT NOT NULL DEFAULT 'api_key',
      params      TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_credentials_type_provider ON credentials(type, provider);
  `);
}

function ensureModelConfigCredentialIdColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(model_configs)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("credential_id")) {
    db.exec("ALTER TABLE model_configs ADD COLUMN credential_id TEXT");
  }
}

// Idempotent backfill: for each model_config still carrying an inline
// `api_key` (and no `credential_id` yet), create a credential row and
// link by id. Strips the api_key / base_url / extra_headers fields from
// the model's params so the credential is the single source of truth.
// Runs every boot; no-op once every legacy row has been migrated.
function migrateInlineApiKeysToCredentials(db: DatabaseSync): void {
  const rows = db.prepare(
    "SELECT name, provider, params FROM model_configs WHERE credential_id IS NULL OR credential_id = ''",
  ).all() as Array<{ name: string; provider: string; params: string }>;
  if (rows.length === 0) return;

  const insertCred = db.prepare(
    "INSERT INTO credentials (id, type, provider, auth_method, params, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  );
  const linkModel = db.prepare("UPDATE model_configs SET credential_id=?, params=?, updated_at=? WHERE name=?");
  const existsCred = db.prepare("SELECT 1 FROM credentials WHERE id=?");
  const t = now();

  for (const row of rows) {
    let params: Record<string, unknown>;
    try { params = JSON.parse(decryptIfNeeded(row.params || "{}")) as Record<string, unknown>; }
    catch { continue; }
    const apiKey = typeof params.api_key === "string" ? params.api_key.trim() : "";
    if (!apiKey) continue; // nothing to migrate; row stays unlinked (env-only)

    // Allocate a non-colliding id of the form `model-<provider>[-N]`.
    const base = `model-${row.provider}`;
    let id = base;
    let suffix = 2;
    while ((existsCred.get(id) as unknown) !== undefined) {
      id = `${base}-${suffix++}`;
    }

    const credParams: Record<string, unknown> = { api_key: apiKey };
    if (typeof params.base_url === "string" && params.base_url.trim()) credParams.base_url = params.base_url;
    if (params.extra_headers && typeof params.extra_headers === "object") credParams.extra_headers = params.extra_headers;
    insertCred.run(id, "model", row.provider, "api_key", encrypt(JSON.stringify(credParams)), t, t);

    // Strip the migrated fields from model_configs.params so reads don't
    // see two competing sources of truth for the same secret.
    const cleaned: Record<string, unknown> = { ...params };
    delete cleaned.api_key;
    delete cleaned.base_url;
    delete cleaned.extra_headers;
    linkModel.run(id, encrypt(JSON.stringify(cleaned)), t, row.name);
  }
}

// Idempotent backfill: for each row in memory_store namespace=`integrations`
// (the legacy single-instance store), create a `type='integration'`
// credential keyed `integration-<name>`. Leaves the legacy memory_store
// row in place so existing readers (gmail-oauth, atlassian tool, env-sync,
// health probes, etc.) keep working until commit B switches them over.
// auth_method is `oauth` when the row carries client_id+client_secret,
// else `api_key`. Skips rows whose credential already exists.
function migrateIntegrationsToCredentials(db: DatabaseSync): void {
  const rows = db.prepare(
    "SELECT key, value FROM memory_store WHERE namespace='integrations'",
  ).all() as Array<{ key: string; value: string }>;
  if (rows.length === 0) return;

  const existsCred = db.prepare("SELECT 1 FROM credentials WHERE id=?");
  const insertCred = db.prepare(
    "INSERT INTO credentials (id, type, provider, auth_method, params, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  );
  const t = now();

  for (const row of rows) {
    const id = `integration-${row.key}`;
    if (existsCred.get(id) !== undefined) continue;

    let params: Record<string, unknown>;
    // memory_store rows in sensitive namespaces (including `integrations`)
    // are envelope-encrypted at rest. Decrypt before parsing Ã¢â‚¬â€ without
    // this, JSON.parse throws and the `catch` below silently skips the
    // row, which is what produced the empty-credentials migration on
    // first install. See ADR-0005.
    try { params = JSON.parse(decryptIfNeeded(row.value)) as Record<string, unknown>; }
    catch { continue; }
    if (!params || typeof params !== "object" || Object.keys(params).length === 0) continue;

    const hasClientId = typeof params.client_id === "string" && (params.client_id as string).length > 0;
    const hasClientSecret = typeof params.client_secret === "string" && (params.client_secret as string).length > 0;
    const auth_method = hasClientId && hasClientSecret ? "oauth" : "api_key";

    insertCred.run(id, "integration", row.key, auth_method, encrypt(JSON.stringify(params)), t, t);
  }
}

// Spill legacy inline `image` ContentParts in messages.content down to
// `<dataDir>/files/<sha256>.<ext>` and rewrite the row to hold only an
// `image_ref`. One-shot, idempotent (a second pass sees only refs and
// exits), and resumable (per-row transaction, so a mid-migration crash
// leaves partially-migrated rows in a valid state).
// See ADR-0065 and lib/attachments/spill.ts.
function spillLegacyImageAttachments(db: DatabaseSync): void {
  // Fast bail-out for the common case (no legacy blobs left).
  const pending = db
    .prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE content LIKE '%\"type\":\"image\"%' AND content LIKE '[%'",
    )
    .get() as { c?: number } | undefined;
  const count = Number(pending?.c ?? 0);
  if (count <= 0) return;

  mkdirSync(FILES_DIR, { recursive: true });

  const MIME_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
  };
  const extFor = (mt: string) => MIME_EXT[mt.toLowerCase()] ?? "bin";

  const selectRows = db.prepare(
    "SELECT msg_id, content FROM messages WHERE content LIKE '%\"type\":\"image\"%' AND content LIKE '[%'",
  );
  const updateRow = db.prepare("UPDATE messages SET content = ? WHERE msg_id = ?");

  let migrated = 0;
  let skipped = 0;
  let dirty = false;
  const started = Date.now();
  console.log(`[migrate-image-refs] scanning ${count} candidate rows ...`);

  const rows = selectRows.iterate() as unknown as IterableIterator<{ msg_id: string; content: string }>;
  for (const row of rows) {
    let parsed: unknown;
    try { parsed = JSON.parse(row.content); }
    catch { skipped++; continue; }
    if (!Array.isArray(parsed)) { skipped++; continue; }

    const parts = parsed as Array<Record<string, unknown>>;
    let rowDirty = false;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p || p.type !== "image") continue;
      const media = typeof p.media_type === "string" ? p.media_type : "application/octet-stream";
      const data = typeof p.data === "string" ? p.data : null;
      if (!data) continue;

      let buf: Buffer;
      try { buf = Buffer.from(data, "base64"); }
      catch { continue; }
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const name = `${sha256}.${extFor(media)}`;
      if (!isSafeFileName(name)) continue;
      const abs = join(FILES_DIR, name);

      let onDisk = false;
      try { const s = statSync(abs); onDisk = s.isFile() && s.size === buf.length; }
      catch { onDisk = false; }
      if (!onDisk) writeFileSync(abs, buf);

      parts[i] = {
        type: "image_ref",
        media_type: media,
        name,
        sha256,
        size: buf.length,
      };
      rowDirty = true;
    }
    if (rowDirty) {
      updateRow.run(JSON.stringify(parts), row.msg_id);
      migrated++;
      dirty = true;
      if (migrated % 100 === 0) {
        console.log(`[migrate-image-refs] migrated ${migrated} rows so far ...`);
      }
    } else {
      skipped++;
    }
  }

  if (dirty) {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `[migrate-image-refs] done: ${migrated} migrated, ${skipped} skipped in ${secs}s`,
    );
  }
}
