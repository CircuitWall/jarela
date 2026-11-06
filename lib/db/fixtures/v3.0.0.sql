-- Schema emitted by the Jarela v3.0.0 migration runner on a fresh database.
CREATE TABLE access_whitelist (
      identity      TEXT PRIMARY KEY,
      display_name  TEXT,
      added_at      TEXT NOT NULL,
      last_seen_at  TEXT
    );

CREATE TABLE agent_configs (
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
      router_policy     TEXT,
      router_enabled    INTEGER,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    , history_limit INTEGER NOT NULL DEFAULT 50, history_window_hours INTEGER NOT NULL DEFAULT 8, warm_summary_limit INTEGER NOT NULL DEFAULT 50, hot_turn_limit INTEGER NOT NULL DEFAULT 12, never_reply INTEGER NOT NULL DEFAULT 0, voice_enabled INTEGER NOT NULL DEFAULT 0, voice_model TEXT NOT NULL DEFAULT 'gemini-2.5-flash-preview-tts', voice_name TEXT NOT NULL DEFAULT 'Kore', voice_stt_model TEXT NOT NULL DEFAULT 'gemini-2.5-flash', voice_auto_speak INTEGER NOT NULL DEFAULT 1, harness_id TEXT, delegate_targets TEXT, context_tier_proportions TEXT, anti_hallucination_mode TEXT, anti_hallucination_model_config TEXT, require_source_links INTEGER NOT NULL DEFAULT 0, citation_strictness TEXT NOT NULL DEFAULT 'off', usage_profile TEXT NOT NULL DEFAULT 'custom' CHECK(usage_profile IN ('home','work','dev','custom')), display_filters TEXT, tool_credentials TEXT, usage_strategy TEXT);

CREATE TABLE allowed_sites (
      hostname            TEXT PRIMARY KEY,                 -- exact host, lowercased; suffix match handled in code
      ssrf_bypass         INTEGER NOT NULL DEFAULT 0,       -- 1 = let web_fetch reach private/loopback addresses for this host
      cookies_blob        TEXT,                             -- envelope-encrypted "name=value; Ã¢â‚¬Â¦"; NULL until extension first PUTs cookies
      created_at          TEXT NOT NULL,
      last_used_at        TEXT,
      cookies_updated_at  TEXT
    );

CREATE TABLE background_tool_results (
      key TEXT PRIMARY KEY REFERENCES runtime_operations(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      tool TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','done','error')),
      payload TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      expires_at INTEGER NOT NULL
    );

CREATE TABLE bridge_ignores (
      id          TEXT PRIMARY KEY,
      bridge_id   TEXT NOT NULL,
      remote_jid  TEXT NOT NULL,                       -- e.g. 5511...@s.whatsapp.net or ...@g.us or ...@lid
      label       TEXT,                                -- user-visible name captured at add time
      created_at  TEXT NOT NULL,
      UNIQUE(bridge_id, remote_jid)
    );

CREATE TABLE bridge_routes (
      id          TEXT PRIMARY KEY,
      bridge_id   TEXT NOT NULL,
      remote_jid  TEXT NOT NULL,                       -- e.g. 5511...@s.whatsapp.net or ...@g.us
      agent_id    TEXT NOT NULL,
      label       TEXT,                                -- user-visible name (push_name on first inbound)
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL, silent_mode INTEGER NOT NULL DEFAULT 0, respond_to TEXT NOT NULL DEFAULT 'counterpart', last_seen_ts INTEGER,
      UNIQUE(bridge_id, remote_jid),
      UNIQUE(agent_id)                                 -- one route per agent (catch-all may intentionally multiplex chats)
    );

CREATE TABLE bridges (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,                       -- registered bridge module kind
      name        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'disconnected',-- disconnected | pairing | connected | error
      qr          TEXT,                                -- base64 data URL while status='pairing'
      last_error  TEXT,
      paired_id   TEXT,                                -- the remote-account identifier (e.g. WhatsApp phone JID) once paired
      enabled     INTEGER NOT NULL DEFAULT 0,
      forward_group_profile_updates      INTEGER NOT NULL DEFAULT 1,
      forward_group_participants_updates INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

CREATE TABLE browser_command_log (
      cmd_id        TEXT PRIMARY KEY,
      type          TEXT NOT NULL,
      status        TEXT NOT NULL,
      host          TEXT,
      tab_id        INTEGER,
      summary       TEXT NOT NULL,
      retryable     INTEGER NOT NULL DEFAULT 0,
      retry_payload TEXT,
      risk_level    TEXT,
      risk_reasons  TEXT NOT NULL DEFAULT '[]',
      last_phase     TEXT,
      last_progress_at TEXT,
      error         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      completed_at  TEXT
    );

CREATE TABLE builtin_tool_categories (
      category   TEXT PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

CREATE TABLE change_tracker (
      scope        TEXT NOT NULL,
      key          TEXT NOT NULL,
      fingerprint  TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    );

CREATE TABLE claude_delegate_sessions (
      project_key TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

CREATE TABLE codex_delegate_sessions (
      project_key TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

CREATE TABLE credentials (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      provider    TEXT NOT NULL,
      auth_method TEXT NOT NULL DEFAULT 'api_key',
      params      TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    , label TEXT, is_default INTEGER NOT NULL DEFAULT 0);

CREATE TABLE disabled_packages (
      id         TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL
    );

CREATE TABLE document_chunks (
      id              TEXT PRIMARY KEY,
      document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index     INTEGER NOT NULL,
      text            TEXT NOT NULL,
      start_offset    INTEGER NOT NULL,
      end_offset      INTEGER NOT NULL,
      embedding       TEXT, embed_failed_at TEXT, embed_error TEXT, embedding_model_signature TEXT,
      UNIQUE(document_id, chunk_index)
    );

CREATE TABLE document_sources (
      id              TEXT PRIMARY KEY,
      path            TEXT NOT NULL,
      label           TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      last_scan_at    TEXT,
      last_error      TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'local_folder', config TEXT, last_cursor TEXT,
      UNIQUE(path)
    );

CREATE TABLE documents (
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

CREATE TABLE mcp_servers (
      name          TEXT PRIMARY KEY,
      transport     TEXT NOT NULL,           -- 'stdio' | 'http'
      spec          TEXT NOT NULL DEFAULT '{}',  -- JSON: { command, args, env } or { url, headers }
      enabled       INTEGER NOT NULL DEFAULT 1,
      last_error    TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

CREATE TABLE memory_store (
      namespace  TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, embedding TEXT,
      PRIMARY KEY (namespace, key)
    );

CREATE TABLE message_embedding_jobs (
      message_id       TEXT PRIMARY KEY REFERENCES messages(msg_id) ON DELETE CASCADE,
      source_hash      TEXT NOT NULL DEFAULT '',
      model_signature  TEXT,
      attempted_signature TEXT,
      state            TEXT NOT NULL DEFAULT 'pending'
                       CHECK(state IN ('pending','processing','done','failed','skipped')),
      attempts         INTEGER NOT NULL DEFAULT 0,
      available_at_ms  INTEGER NOT NULL DEFAULT 0,
      lease_until_ms   INTEGER,
      last_error       TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );

CREATE TABLE message_seq_allocator (
      id       INTEGER PRIMARY KEY CHECK (id=1),
      last_seq INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE message_usage (
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
    , hot_tokens INTEGER, warm_tokens INTEGER, facts_tokens INTEGER, overhead_tokens INTEGER, hot_budget_tokens INTEGER, warm_budget_tokens INTEGER, facts_budget_tokens INTEGER, context_window_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER, thinking_tokens INTEGER);

CREATE TABLE messages (
      msg_id     TEXT PRIMARY KEY,
      thread_id  TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      transcript_status TEXT NOT NULL DEFAULT 'completed',
      status_reason TEXT
    , embedding TEXT, tool_events TEXT, category TEXT, metadata TEXT);

CREATE TABLE model_configs (
      name       TEXT PRIMARY KEY,
      provider   TEXT NOT NULL,
      model_id   TEXT NOT NULL,
      params     TEXT NOT NULL DEFAULT '{}',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , credential_id TEXT, enabled INTEGER NOT NULL DEFAULT 1);

CREATE TABLE pending_actions (
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

CREATE TABLE proxy_config (
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

CREATE TABLE runtime_operations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      origin_instance TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('accepted','completed','failed','outcome_unknown')),
      payload TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE scheduled_tasks (
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

CREATE TABLE signal_deliveries (
      event_id TEXT PRIMARY KEY REFERENCES signal_events(id) ON DELETE CASCADE,
      wake_eligible INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK(state IN ('ready','leased','acknowledged','dead_letter')),
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      lease_token TEXT,
      lease_instance TEXT,
      lease_until INTEGER,
      failure_code TEXT,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE signal_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      operation_id TEXT NOT NULL REFERENCES runtime_operations(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(kind,operation_id,agent_id,thread_id)
    );

CREATE TABLE skill_repos (
      id          TEXT PRIMARY KEY,
      path        TEXT NOT NULL,
      label       TEXT,
      writable    INTEGER NOT NULL DEFAULT 0,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      UNIQUE(path)
    );

CREATE TABLE task_assignments (
      agent_id          TEXT PRIMARY KEY,
      model_config_name TEXT NOT NULL,
      allow_tools       TEXT NOT NULL DEFAULT '[]',
      deny_tools        TEXT NOT NULL DEFAULT '[]',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

CREATE TABLE thread_channel_summaries (
      thread_id       TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      channel         TEXT NOT NULL,
      summary         TEXT NOT NULL,
      summary_before  TEXT,
      summary_before_seq INTEGER,
      computed_at     TEXT NOT NULL, topics TEXT,
      PRIMARY KEY (thread_id, channel)
    );

CREATE TABLE threads (
      thread_id     TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      title         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0
    , hot_since TEXT, hot_since_seq INTEGER, warm_summary TEXT, warm_summary_before TEXT, warm_summary_before_seq INTEGER, warm_summary_computed_at TEXT, warm_summary_source_messages INTEGER, warm_summary_source_chars INTEGER, warm_summary_topics TEXT, auto_boundary_locked_until_msg_count INTEGER NOT NULL DEFAULT 0);

CREATE TABLE tool_failure_samples (
      tool_name          TEXT NOT NULL,
      normalized_reason  TEXT NOT NULL,
      failure_class      TEXT NOT NULL DEFAULT 'suspected_product_gap',
      workflow_name      TEXT,
      event_type         TEXT,
      extraction_valid   INTEGER NOT NULL DEFAULT 0,
      intended_tool      TEXT,
      blocked_operation  TEXT,
      count              INTEGER NOT NULL DEFAULT 0,
      sample_error       TEXT NOT NULL,
      sample_arg_shape   TEXT NOT NULL,
      first_seen_at      TEXT NOT NULL,
      last_seen_at       TEXT NOT NULL,
      PRIMARY KEY (tool_name, normalized_reason)
    );

CREATE TABLE tool_stats (
      tool_name      TEXT PRIMARY KEY,
      call_count     INTEGER NOT NULL DEFAULT 0,
      success_count  INTEGER NOT NULL DEFAULT 0,
      error_count    INTEGER NOT NULL DEFAULT 0,
      used_count     INTEGER NOT NULL DEFAULT 0,
      last_called_at TEXT,
      updated_at     TEXT NOT NULL
    );

CREATE TABLE user_profile (
      id         TEXT PRIMARY KEY DEFAULT 'me',
      name       TEXT NOT NULL DEFAULT '',
      icon       TEXT,
      about      TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , location_lat REAL, location_lng REAL, location_accuracy_m REAL, location_label TEXT, location_updated_at TEXT, location_consent INTEGER NOT NULL DEFAULT 0, preset TEXT);

CREATE TABLE watchers (
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

CREATE TABLE workspace_scan_cache (
      cache_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      scanned_at TEXT NOT NULL
    );

CREATE INDEX idx_background_results_expiry ON background_tool_results(expires_at);

CREATE INDEX idx_background_results_owner ON background_tool_results(thread_id,expires_at);

CREATE INDEX idx_bridge_ignores_bridge ON bridge_ignores(bridge_id);

CREATE INDEX idx_bridge_routes_bridge ON bridge_routes(bridge_id);

CREATE INDEX idx_browser_command_log_created ON browser_command_log(created_at DESC);

CREATE INDEX idx_browser_command_log_status ON browser_command_log(status, created_at DESC);

CREATE INDEX idx_chunks_document ON document_chunks(document_id);

CREATE INDEX idx_credentials_type_provider ON credentials(type, provider);

CREATE INDEX idx_documents_source ON documents(source_id);

CREATE INDEX idx_memory_namespace_updated ON memory_store(namespace,updated_at DESC);

CREATE INDEX idx_memory_updated ON memory_store(updated_at DESC);

CREATE INDEX idx_message_embedding_jobs_due
      ON message_embedding_jobs(state, available_at_ms, lease_until_ms);

CREATE INDEX idx_message_embedding_jobs_lease
      ON message_embedding_jobs(state, lease_until_ms);

CREATE INDEX idx_message_usage_agent_id   ON message_usage(agent_id);

CREATE INDEX idx_message_usage_created_at ON message_usage(created_at);

CREATE INDEX idx_message_usage_thread_created ON message_usage(thread_id,created_at DESC);

CREATE INDEX idx_messages_created_at ON messages(created_at);

CREATE INDEX idx_messages_thread_id ON messages(thread_id, created_at);

CREATE INDEX idx_messages_thread_seq ON messages(thread_id);

CREATE INDEX idx_pending_actions_agent_status ON pending_actions(agent_id, status, created_at);

CREATE INDEX idx_pending_actions_status ON pending_actions(status, created_at);

CREATE INDEX idx_runtime_operations_thread_state ON runtime_operations(thread_id,state);

CREATE INDEX idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);

CREATE INDEX idx_signal_deliveries_due ON signal_deliveries(state,available_at);

CREATE INDEX idx_signal_deliveries_lease ON signal_deliveries(state,lease_until);

CREATE INDEX idx_signal_events_operation ON signal_events(operation_id);

CREATE INDEX idx_signal_events_target ON signal_events(agent_id,thread_id,seq);

CREATE INDEX idx_signal_events_thread ON signal_events(thread_id);

CREATE INDEX idx_thread_channel_summaries_thread ON thread_channel_summaries(thread_id);

CREATE UNIQUE INDEX idx_threads_agent_id ON threads(agent_id);

CREATE INDEX idx_threads_updated ON threads(updated_at DESC);

CREATE INDEX idx_tool_failure_samples_last_seen
      ON tool_failure_samples(last_seen_at);

CREATE INDEX idx_watchers_due ON watchers(enabled, next_run_at);

CREATE INDEX idx_workspace_scan_cache_scanned_at ON workspace_scan_cache(scanned_at);

INSERT INTO message_seq_allocator (id, last_seq) VALUES (1, 0);
