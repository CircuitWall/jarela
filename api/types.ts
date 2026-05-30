export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  icon: string | null;
}

export interface AgentConfig {
  id: string;
  name: string;
  icon: string | null;
  identity: string;
  instructions: string;
  tools: string[];
  model_config_name: string | null;
  is_default: boolean;
  history_limit: number;
  history_window_hours: number;
  never_reply: boolean;
  adaptive_persona_enabled: boolean;
  adaptive_persona_strength: number;
  adaptive_empathy: number;
  adaptive_expressiveness: number;
  adaptive_verbosity: number;
  adaptive_mbti: string;
  voice_enabled: boolean;
  voice_model: string;
  voice_name: string;
  voice_stt_model: string;
  voice_auto_speak: boolean;
  /**
   * Optional override for which behavioral harness wraps this agent's system
   * prompt. NULL = inherit the global default. Built-in IDs are prefixed
   * `builtin:`; user-created customs are prefixed `custom:`.
   */
  harness_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentConfigIn {
  name: string;
  icon?: string | null;
  identity?: string;
  instructions?: string;
  tools?: string[];
  model_config_name?: string | null;
  is_default?: boolean;
  history_limit?: number;
  history_window_hours?: number;
  never_reply?: boolean;
  adaptive_persona_enabled?: boolean;
  adaptive_persona_strength?: number;
  adaptive_empathy?: number;
  adaptive_expressiveness?: number;
  adaptive_verbosity?: number;
  adaptive_mbti?: string;
  voice_enabled?: boolean;
  voice_model?: string;
  voice_name?: string;
  voice_stt_model?: string;
  voice_auto_speak?: boolean;
  harness_id?: string | null;
}

export interface ThreadSummary {
  thread_id: string;
  agent_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface PersistedToolEvent {
  id: string;
  phase: "call" | "result";
  name: string;
  payload: unknown;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  // Captured live during the run, persisted with the assistant message.
  // Lets the chat UI render historical tool invocations the same way it
  // renders live streaming ones.
  tool_events?: PersistedToolEvent[];
  // Optional classification tag. NULL/undefined = ordinary chat content.
  // Known values: 'scheduled_task' (scheduler firings), 'watcher'
  // (watcher-trigger firings, ADR-0027), 'bridge' (bridge adapter
  // traffic), 'synthetic' (page-capture / file-upload synthetic user
  // messages). The chat-panel filter toolbar lets the user toggle each
  // category on/off; persistence is the same regardless.
  category?: string | null;
}

export interface ThreadDetail extends ThreadSummary {
  messages: Message[];
  has_more: boolean;
}

export interface MemoryItem {
  namespace: string;
  key: string;
  value: unknown;
  created_at: string;
  updated_at: string;
}

export interface ModelConfig {
  name: string;
  provider: "openai" | "anthropic" | "github-copilot" | string;
  model_id: string;
  params: {
    api_key?: string;
    base_url?: string;
    extra_headers?: Record<string, string>;
    temperature?: number;
    max_tokens?: number;
    context_window_tokens?: number;
    context_tier_proportions?: {
      hot?: number;
      warm?: number;
      facts?: number;
    };
    context_tier_priority?: ["hot" | "warm" | "facts", "hot" | "warm" | "facts", "hot" | "warm" | "facts"];
  };
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface ModelConfigIn {
  provider: string;
  model_id: string;
  params?: ModelConfig["params"];
  is_default?: boolean;
}

export interface TaskAssignment {
  agent_id: string;
  model_config_name: string;
  tool_policy?: ToolPolicy;
  created_at: string;
  updated_at: string;
}

export interface StreamFilters {
  include_tools?: boolean;
  include_thinking?: boolean;
}

export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}

export interface StreamOptions {
  filters?: StreamFilters;
  tool_policy?: ToolPolicy;
  ui_experience_mode?: "normal" | "advanced";
}

export interface UserProfile {
  id: string;
  name: string;
  icon: string | null;
  about: string;
  created_at: string;
  updated_at: string;
  // Geolocation (opt-in). All null when sharing is off.
  location_lat?: number | null;
  location_lng?: number | null;
  location_accuracy_m?: number | null;
  location_label?: string | null;
  location_updated_at?: string | null;
  location_consent?: number; // 0 | 1
  /**
   * Persona preset selected in the Profile editor (home/work/dev/custom).
   * Drives the Credentials panel's category filter. `null` or absent
   * = no filter (show all integrations — the legacy behaviour).
   */
  preset?: "home" | "work" | "dev" | "custom" | null;
}

export interface AccessWhitelistEntry {
  identity: string;
  display_name: string | null;
  added_at: string;
  last_seen_at: string | null;
}

export interface ToolInfo {
  name: string;
  description: string;
  /** "builtin" = shipped with Jarela; "mcp" = provided by a connected MCP server. */
  source?: "builtin" | "mcp";
  /** UI grouping label (e.g. "Files", "Web", "MCP"). */
  category?: string;
  /**
   * Optional parent group rendered above the category in the Agent editor.
   * Currently used to collapse vendor-native categories (Atlassian, GitHub)
   * under a single "Work" header. `null` (or absent) means render flat.
   */
  group?: string | null;
  stats?: ToolUsefulnessStats;
}

export interface ToolUsefulnessStats {
  call_count: number;
  success_count: number;
  error_count: number;
  used_count: number;
  success_rate: number;
  usefulness_rate: number;
  score: number;
  never_used: boolean;
  last_called_at: string | null;
}

export interface DashboardSeriesPoint {
  day: string;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
  tool_calls: number;
  tool_successes: number;
  tool_errors: number;
  success_rate: number;
  error_rate: number;
}

export interface DashboardToolTop {
  name: string;
  call_count: number;
  success_count: number;
  error_count: number;
  score: number;
  success_rate: number;
  last_called_at: string | null;
}

export interface DashboardAgentTop {
  agent_id: string;
  agent_name: string;
  message_count: number;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
}

export interface DashboardProviderRate {
  provider: string;
  input_per_1m_usd: number | null;
  output_per_1m_usd: number | null;
  source: string;
}

export interface DashboardMetrics {
  generated_at: string;
  days: number;
  summary: {
    input_tokens_est: number;
    output_tokens_est: number;
    estimated_cost_usd: number;
    tool_calls: number;
    tool_successes: number;
    tool_errors: number;
    success_rate: number;
    error_rate: number;
  };
  series: DashboardSeriesPoint[];
  top_tools: DashboardToolTop[];
  top_agents: DashboardAgentTop[];
  pricing: {
    snapshot_generated_at: string | null;
    rates: DashboardProviderRate[];
    notes: string;
  };
}

/** One built-in tool category with its current enable state. */
export interface BuiltinToolCategoryInfo {
  category: string;
  enabled: boolean;
  toolCount: number;
  toolNames: string[];
}

export interface McpServer {
  name: string;
  transport: "stdio" | "http";
  spec: Record<string, unknown>;
  enabled: boolean;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface McpServerIn {
  name: string;
  transport: "stdio" | "http";
  spec: Record<string, unknown>;
  enabled?: boolean;
}

export interface McpRegistryVariable {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  default?: string;
}

export interface IntegrationField {
  key: string;
  label: string;
  placeholder?: string;
  secret: boolean;
  required: boolean;
}

export interface IntegrationDefinition {
  name: string;
  label: string;
  description: string;
  fields: IntegrationField[];
  /**
   * Persona-filter bucket. Drives whether the Credentials panel shows
   * this integration for the current Profile preset. Optional for
   * back-compat with older clients.
   */
  category?: "llm" | "mail" | "calendar" | "issue-tracker" | "chat" | "infrastructure" | "other";
}

export interface IntegrationStatus {
  name: string;
  configured: boolean;
  values: Record<string, string>; // secrets masked as "********"
  updated_at: string | null;
  /**
   * Per-field provenance flags. `"rc"` = pulled from a shell-rc /
   * Windows-registry env var by the env-syncer. `"user"` = the user
   * typed it into the panel. Drives the "from your shell" badge.
   */
  source?: Record<string, "rc" | "user">;
  /** ISO timestamp of the last successful rc-sync write. */
  rc_synced_at?: string | null;
}

export interface IntegrationsListResponse {
  definitions: IntegrationDefinition[];
  statuses: IntegrationStatus[];
}

// ---------------------------------------------------------------------------
// Env-sync — auto-pickup of standard credential env vars from shell rc
// (macOS / Linux) or User-scope registry (Windows). See lib/env/sync.ts.
// ---------------------------------------------------------------------------

export type EnvSyncDiscoverySource =
  | "process"
  | "shell-rc"
  | "windows-registry"
  | "unavailable";

export type EnvSyncAction =
  | "would-write"
  | "skipped-user"
  | "skipped-equal"
  | "skipped-empty"
  | "absent";

export interface EnvSyncCandidate {
  envVar: string | null;
  integration: string;
  field: string;
  current_source: "rc" | "user" | "absent";
  current_value_present: boolean;
  rc_value_preview: string | null;
  action: EnvSyncAction;
}

export interface EnvSyncResult {
  discovered: {
    values: Record<string, string>;       // raw values; UI should not display these directly
    source: EnvSyncDiscoverySource;
    shell: string | null;
    warnings: string[];
    elapsed_ms: number;
  };
  candidates: EnvSyncCandidate[];
  applied_count: number;
  ts: string;
}

/** One allowlist row — env-var name(s) → an existing integration field. */
export interface EnvAllowlistMapping {
  envVars: string[];
  integration: string;
  field: string;
}

/**
 * Allowlist API payload. `defaults` is the code-owned ENV_ALLOWLIST.
 * `overrides` keys are `"<integration>:<field>"` pointing at the user's
 * additional env-var aliases (defaults always remain, even if missing
 * from the override list).
 */
export interface EnvAllowlistConfig {
  defaults: EnvAllowlistMapping[];
  overrides: Record<string, string[]>;
}

export interface ScheduledTask {
  id: string;
  agent_id: string;
  prompt: string;
  description: string | null;
  kind: "once" | "cron";
  schedule: string;            // ISO timestamp for "once", cron expr for "cron"
  next_run_at: string;
  last_run_at: string | null;
  last_error: string | null;
  enabled: boolean;
  // When true the scheduler wraps the prompt with a "reply only if material"
  // directive and a NO_REPLY sentinel. NO_REPLY turns are not persisted at
  // all. All other scheduler firings are tagged with `category=scheduled_task`
  // so the chat-panel filter toolbar can hide them en masse.
  silent: boolean;
  // ADR-0032 — discriminated reaction. 'agent_prompt' (default) runs the
  // agent with `prompt`; 'script' runs a registered reaction.* script with
  // no LLM round-trip.
  reaction_kind: "agent_prompt" | "script";
  reaction_script: string | null;
  reaction_script_args: unknown | null;
  created_at: string;
  updated_at: string;
}

// Event-driven watcher (ADR-0027). Sibling of ScheduledTask: instead of
// firing on a cron, the scheduler polls one built-in tool every
// `interval_seconds` and only invokes the agent when the tool's output
// changes since the previous poll.
export interface Watcher {
  id: string;
  agent_id: string;
  label: string;
  tool: string;
  args: unknown;
  interval_seconds: number;
  next_run_at: string;
  last_run_at: string | null;
  last_fired_at: string | null;
  last_error: string | null;
  enabled: boolean;
  silent: boolean;
  // ADR-0030: optional user-supplied directive substituted for the default
  // "summarise the diff" instruction when the watcher fires. NULL = default.
  reaction_prompt: string | null;
  // ADR-0031: discriminator for the reaction. 'agent_prompt' (default)
  // routes to a PromptFiring (uses reaction_prompt); 'script' routes to a
  // ScriptFiring (uses reaction_script + reaction_script_args).
  reaction_kind: "agent_prompt" | "script";
  reaction_script: string | null;
  reaction_script_args: unknown | null;
  created_at: string;
  updated_at: string;
}

// Document RAG (ADR-0024). A folder on the user's machine that Jarela
// scans on a timer; matching text files are chunked + embedded into
// `document_chunks` and surfaced to agents via the `documents_search`
// tool.
export interface DocumentSourceStats {
  source_id: string;
  document_count: number;
  chunk_count: number;
  embedded_chunk_count: number;
}

// ADR-0026 — `kind` discriminates local-folder sources from remote ones
// (Jira/Confluence). ADR-0029 added GitHub kinds. For local sources
// `path` is the absolute folder path; for remote sources it is a
// synthetic key (e.g. `jira-project://ACME`, `github-pulls://owner/repo`)
// generated by the API and treated as opaque on the client.
export type DocumentSourceKind =
  | "local_folder"
  | "confluence_space"
  | "confluence_cql"
  | "jira_project"
  | "jira_jql"
  | "github_pulls"
  | "github_repo"
  | "gmail_mail"
  | "outlook_mail";

export interface DocumentSource {
  id: string;
  path: string;
  label: string | null;
  enabled: boolean;
  last_scan_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  kind: DocumentSourceKind;
  config: Record<string, unknown> | null;
  stats: DocumentSourceStats;
}

export type DocumentSourceIn =
  | { path: string; label?: string | null; kind?: "local_folder" }
  | {
      kind: Exclude<DocumentSourceKind, "local_folder">;
      label: string;
      config: Record<string, unknown>;
    };

export interface DocumentSourcePatch {
  label?: string | null;
  enabled?: boolean;
}

export interface DocumentHit {
  document_id: string;
  source_id: string;
  source_label: string | null;
  rel_path: string;
  abs_path: string;
  chunk_index: number;
  text: string;
  score: number;
  match: "semantic" | "substring";
}

export interface DocumentReindexResult {
  source_id: string;
  stats: {
    scanned: number;
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
    errors: number;
    embed_failed?: number;
    embed_error?: string | null;
  };
}

export interface DocumentSettings {
  embedding_model_config: string | null;
  embedding_probe?: {
    ok: boolean;
    provider: string;
    model_id: string;
    dimension?: number;
    error?: string;
  } | null;
}


export interface PendingAction {
  id: string;
  agent_id: string;
  kind:
    | "install_mcp"
    | "toggle_mcp"
    | "update_agent_tools"
    | "update_agent"
    | "start_oauth"
    | "set_provider_key"
    | "enable_integration"
    | "upsert_harness";
  payload: Record<string, unknown>;
  reason: string | null;
  status: "pending" | "approved" | "denied" | "failed";
  result: unknown;
  created_at: string;
  decided_at: string | null;
}

export interface McpRegistryEntry {
  id: string;
  name: string;
  description: string;
  category: "Local" | "Web" | "Data" | "Productivity" | "Search" | "Cloud" | "Corporate";
  source: "Official" | "Community" | "Vendor";
  url?: string;
  transport: "stdio" | "http";
  spec: Record<string, unknown>;
  variables?: McpRegistryVariable[];
}

export interface CatalogModel {
  id: string;
  context_length: number | null;
  max_output_tokens: number | null;
  hosted_on: string | null;
  capabilities: {
    vision: boolean;
    tools: boolean;
    streaming: boolean;
    json_mode: boolean;
    web_search: boolean;
    audio: boolean;
    files: boolean;
  };
}

export type { ContentPart, MessageContent } from "@/lib/tools/types";

import type {
  Harness as _Harness,
  HarnessSection as _HarnessSection,
  HarnessSectionKey as _HarnessSectionKey,
} from "@/lib/agents/harness/types";

export type {
  Harness,
  HarnessSection,
  HarnessSectionKey,
} from "@/lib/agents/harness/types";
export {
  HARNESS_SECTION_KEYS,
  DEFAULT_HARNESS_ID,
  isBuiltinHarnessId,
  SECTION_DISPLAY,
} from "@/lib/agents/harness/types";

export interface HarnessListResponse {
  harnesses: _Harness[];
  default_harness_id: string;
}

export interface HarnessIn {
  name: string;
  description?: string;
  sections?: Partial<Record<_HarnessSectionKey, Partial<_HarnessSection>>>;
}

export interface HarnessPatch {
  name?: string;
  description?: string;
  sections?: Partial<Record<_HarnessSectionKey, Partial<_HarnessSection>>>;
}

export type SSEEventType =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: unknown }
  | { type: "done"; message_id: string; usage: { input_tokens: number; output_tokens: number } }
  | { type: "error"; message: string; code: string }
  // Server is rejecting a new POST/WS message because a run is already in
  // flight for this thread (another tab, another device). The stream that
  // follows replays the in-flight run's buffered events plus live deltas;
  // the client should re-queue the user message locally and resubmit after
  // the upcoming `done` event.
  | { type: "run_in_flight"; thread_id: string };

// ---------------------------------------------------------------------------
// Bridges (external comm channels: WhatsApp via Baileys, …)
// ---------------------------------------------------------------------------

export type BridgeKind = "whatsapp";
export type BridgeStatus = "disconnected" | "pairing" | "connected" | "error";

export interface Bridge {
  id: string;
  kind: BridgeKind;
  name: string;
  status: BridgeStatus;
  last_error: string | null;
  paired_id: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface BridgeIn {
  kind: BridgeKind;
  name: string;
}

export interface BridgePatch {
  name?: string;
  enabled?: boolean;
}

export interface BridgeLiveStatus {
  id: string;
  status: BridgeStatus;
  /** Data URL (image/png;base64,…) for the pairing QR, present only while `status==='pairing'`. */
  qr_data_url: string | null;
  last_error: string | null;
  paired_id: string | null;
  running: boolean;
  enabled: boolean;
}

export interface BridgeRoute {
  id: string;
  bridge_id: string;
  remote_jid: string;       // "*" (catch-all) or e.g. "5511999990000@s.whatsapp.net" / "<group-id>@g.us"
  agent_id: string;
  label: string | null;
  // When true, the agent still runs (records history, executes tools) on
  // every inbound message but the dispatcher suppresses the outbound reply.
  // Per-route so the same agent can be a replier in one chat and an
  // observer in another. Hardwired guard — overrides `respond_to`; the
  // adapter re-checks this inside its own send path so even tool calls
  // can't bypass it.
  silent_mode: boolean;
  // Which inbound sender role triggers an outbound reply. The agent
  // ALWAYS runs (so it sees the full conversation), but the reply only
  // goes out when the message that triggered the run matches this role.
  // - 'counterpart' (default): agent answers the user's chat partner /
  //   group members but stays quiet on the user's own messages.
  // - 'user': agent only reacts to the paired user's own messages.
  // silent_mode overrides — when set, nothing goes out regardless.
  respond_to: "user" | "counterpart";
  created_at: string;
  updated_at: string;
}

export interface BridgeRouteIn {
  remote_jid: string;       // "*" enables fallback routing for otherwise-unmatched chats
  agent_id: string;
  label?: string | null;
  silent_mode?: boolean;
  respond_to?: "user" | "counterpart";
}

export interface BridgeRoutePatch {
  remote_jid?: string;
  agent_id?: string;
  label?: string | null;
  silent_mode?: boolean;
  respond_to?: "user" | "counterpart";
}

export interface BridgeChat {
  remote_jid: string;
  name: string | null;
  is_group: boolean;
  last_message_at: number | null;
}

export interface BridgeChatsResponse {
  running: boolean;
  chats: BridgeChat[];
}

// ---------------------------------------------------------------------------
// Proxy configuration (ADR-0009)
// ---------------------------------------------------------------------------

export type ProxyMode = "off" | "manual" | "system";
export type ProxyScheme = "http" | "https";        // ADR-0012

export interface ProxyConfigStatus {
  mode: ProxyMode;
  scheme: ProxyScheme;               // ADR-0012
  host: string | null;
  port: number | null;
  username: string | null;
  password: string | null;           // SECRET_MASK ("********") when set, null when unset
  no_proxy: string | null;
  ca_bundle: string | null;          // PEM, plaintext (ADR-0012). Public cert, not masked.
  updated_at: string | null;
}

export interface ProxyConfigInput {
  mode: ProxyMode;
  scheme?: ProxyScheme;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;          // omit or send SECRET_MASK to keep existing
  no_proxy?: string | null;
  ca_bundle?: string | null;         // null/"" clears; non-empty must be PEM
}

export interface ProxyApplyResult {
  source: "env" | "manual" | "system" | "off";
  proxyUrl: string | null;           // password redacted as "***"
  note?: string;
  // ADR-0020: in `system` mode on macOS the dispatcher auto-extracts the
  // System + login keychain trust stores into a PEM bundle and uses it
  // as the per-request CA. Surfaced so the UI can show
  // "System trust: 187 certs from ~/.jarela/system-ca.pem".
  caBundlePath?: string;
  caBundleCertCount?: number;
  caBundleSource?: "macos-keychain";
}

export interface ProxyConfigEnvelope {
  config: ProxyConfigStatus;
  env_override: boolean;             // true when HTTPS_PROXY env var was set at boot — DB config is ignored
  applied?: ProxyApplyResult;        // present on PUT/DELETE responses
}

export interface TailscaleStatus {
  installed: boolean;
  logged_in: boolean;
  fqdn: string | null;
  serving: boolean;
  serve_recipe: string;
  install_script: string;
  uninstall_script: string;
}

export interface ExtensionInfo {
  name: string;
  file: string | null;
}

// A secret slot declared by an external tool (ADR-0023). `is_set` indicates
// whether a value is currently persisted in the encrypted store; the actual
// secret never leaves the server.
export interface ToolSecretSlotInfo {
  key: string;
  label?: string;
  required?: boolean;
  description?: string;
  is_set: boolean;
}

export interface ExternalToolInfo extends ExtensionInfo {
  description: string;
  category: string | null;
  secrets: ToolSecretSlotInfo[];
}

export interface ExtensionLoadError {
  kind: "provider" | "tool";
  file: string;
  error: string;
}

export interface ExtensionsListResponse {
  directories: { providers: string; tools: string };
  providers: ExtensionInfo[];
  tools: ExternalToolInfo[];
  errors: ExtensionLoadError[];
}