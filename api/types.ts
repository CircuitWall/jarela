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
  /**
   * IDs of other agents this agent is allowed to hand subtasks to via the
   * built-in `delegate_to_agent` tool. Empty array (default) disables
   * delegation even if the tool itself is enabled.
   */
  delegate_targets: string[];
  /**
   * ADR-0043 — per-agent override of the hot/warm/facts split. Any positive
   * numbers; the backend divides by sum so the UI can ship raw weights and
   * never has to reconcile to 100. NULL/missing = inherit the model config's
   * value.
   */
  context_tier_proportions: { hot: number; warm: number; facts: number } | null;
  /**
   * Per-agent override of the anti-hallucination classifier mode.
   *   null      = inherit the global JARELA_HALLUCINATION_DETECTOR_MODE
   *   "off"     = no classifier on this agent's turns
   *   "report"  = classifier runs alongside regex; logs disagreements +
   *               appends a footer when classifier flags a stall regex missed
   *   "enforce" = either regex OR classifier vote triggers retry
   */
  anti_hallucination_mode: "off" | "regex" | "model" | null;
  /**
   * Per-agent override of the anti-hallucination classifier model.
   * Stores the `name` of a saved model config (see Models settings) — pick
   * a fast/cheap one (Haiku, gpt-4o-mini, gemini-flash). NULL = inherit the
   * global JARELA_HALLUCINATION_DETECTOR_MODEL.
   */
  anti_hallucination_model_config: string | null;
  /**
   * Citation strictness (independent of the stall detector). One of:
   *  - `off`           : no checker, no system-prompt directive
   *  - `informational` : checker runs and surfaces a references panel; the
   *                      agent is NOT asked to cite
   *  - `standard`      : agent nudged to cite KEY (load-bearing) claims
   *                      with `[N]` markers
   *  - `strict`        : agent must cite EVERY factual claim AND the stall
   *                      classifier is forced to mode='model' for this
   *                      agent's turns
   * The checker reuses `anti_hallucination_model_config` as the LLM judge.
   */
  citation_strictness: CitationStrictness;
  /**
   * Per-tool credential overrides (`{ toolName: credentialId }`). When a
   * tool's integration has multiple credentials configured, the resolver
   * picks the credential id pinned here for THIS tool. Missing keys fall
   * back to the integration's default credential.
   */
  tool_credentials: Record<string, string>;
  /**
   * Per-agent model router policy override. When set, this agent uses the
   * specified policy instead of the global JARELA_MODEL_ROUTER_POLICY env var.
   * Ignored when `model_config_name` is set (forced model bypasses the router).
   */
  router_policy?: "cheap" | "fast" | "balanced" | "quality" | null;
  /**
   * Per-agent router enable override. true = always route (even when global
   * mode is "off"); false = never route (even when global mode is "heuristic");
   * null = inherit the global JARELA_MODEL_ROUTER_MODE setting.
   */
  router_enabled?: boolean | null;
  created_at: string;
  updated_at: string;
}

/** Citation strictness enum exposed over the wire. Mirrors
 *  `lib/stores/agent-configs#CitationStrictness`. */
export type CitationStrictness = "off" | "informational" | "standard" | "strict";

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
  delegate_targets?: string[];
  // null = clear and inherit from the model; undefined = leave as-is.
  context_tier_proportions?: { hot: number; warm: number; facts: number } | null;
  // null = clear override; undefined = leave as-is.
  anti_hallucination_mode?: "off" | "regex" | "model" | null;
  anti_hallucination_model_config?: string | null;
  // Independent citation strictness ('off' | 'informational' | 'standard' |
  // 'strict'). undefined = leave as-is.
  citation_strictness?: CitationStrictness;
  // Per-tool credential overrides. `undefined` = keep existing. An empty
  // object clears every override.
  tool_credentials?: Record<string, string>;
  // null = clear override (inherit global); undefined = keep existing.
  router_policy?: "cheap" | "fast" | "balanced" | "quality" | null;
  // null = clear override (inherit global); undefined = keep existing.
  router_enabled?: boolean | null;
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
  // Per-turn usage snapshot from message_usage (assistant turns only).
  // Lets the chat UI render a context-window utilisation bar without
  // re-querying. Absent for user turns and for assistant rows persisted
  // before message_usage existed.
  usage?: MessageUsage | null;
  // Auxiliary per-turn metadata. Currently carries the citation-checker
  // verdict when the agent's `citation_strictness` is not `off`. Absent on
  // legacy rows and on turns where no checker ran.
  metadata?: MessageMetadata | null;
  // Client-side only — never returned by the API. 'pending' = optimistic
  // bubble not yet confirmed by the server. 'confirmed' = received from and
  // reconciled with the server. Absent means the same as 'confirmed'.
  status?: 'pending' | 'confirmed';
}

export interface CitationClaim {
  /** Short paraphrase of the claim the checker extracted from the turn. */
  text: string;
  /** Marker number the agent wrote in `[N]` next to the claim, if any. */
  marker?: number | null;
  /** URL or workspace-relative path the agent cited, if any. Resolved from
   *  the source manifest when `marker` is present; null when the agent
   *  attached no marker or the marker wasn't in the manifest. */
  link: string | null;
  /** true = marker present AND in this thread's source manifest. */
  verified: boolean;
  /** Short human-readable explanation; capped at ~120 chars. */
  reason: string;
}

export interface SourceManifestEntry {
  /** 1-based number shown to the agent and used as the inline `[N]` marker. */
  n: number;
  /** Short display label (hostname+path for URLs, the path itself for files). */
  label: string;
  /** Full URL or workspace-relative path the marker resolves to. */
  href: string;
}

/** Per-message tally of values the redaction layer held back from the
 *  LLM. Each entry is a coarse type bucket plus a count; original values
 *  are NEVER stored here — they live in the local checkpoint and never
 *  cross the trust boundary. The chat UI surfaces this as a shield
 *  indicator under the assistant bubble. ADR-0064. */
export interface RedactionSummaryEntry {
  /** Coarse type bucket: `anthropic_api_key`, `swedish_personnummer`,
   *  `iban`, `unknown_long_string`, etc. */
  type_hint: string;
  count: number;
}

export interface RouteDecisionMetadata {
  source: "pinned" | "agent_override" | "heuristic" | "default_fallback";
  model_config_name: string | null;
  route_class?: "simple-chat" | "factual" | "research" | "complex-reasoning" | "multimodal";
  policy?: "cheap" | "fast" | "balanced" | "quality";
  reason: string;
  candidates?: string[];
  duration_ms?: number;
  terminal?: "done" | "error";
  error_code?: string;
  retry_count?: number;
}

export interface MessageMetadata {
  citations?: {
    /** Model config name used as the checker. */
    checker_model: string;
    /** Per-claim verdicts. */
    claims: CitationClaim[];
    /** URLs/paths the agent cited but that aren't in the visited-source set. */
    unverified_links: string[];
    /** Numbered source manifest the agent saw at prompt time. The chat UI
     *  uses it to render inline `[N]` markers as clickable links. */
    sources?: SourceManifestEntry[];
  };
  /** Total values held back from the LLM during this turn (ADR-0064).
   *  Absent on legacy rows and on turns where nothing matched. */
  redaction_summary?: RedactionSummaryEntry[];
  /** Model-selection decision captured before the turn started. */
  routing?: RouteDecisionMetadata;
}

export interface MessageUsage {
  input_tokens: number;
  output_tokens: number;
  // Per-tier input-token breakdown + the budget cap each tier was given,
  // captured at history-window assembly time. NULL on legacy rows persisted
  // before ADR-0044 wired this up — the chat UI falls back to a proportional
  // visualisation in that case.
  hot_tokens: number | null;
  warm_tokens: number | null;
  facts_tokens: number | null;
  overhead_tokens: number | null;
  hot_budget_tokens: number | null;
  warm_budget_tokens: number | null;
  facts_budget_tokens: number | null;
  context_window_tokens: number | null;
  // Anthropic prompt-cache breakdown (ADR-0062). Disjoint from
  // `input_tokens`: Anthropic returns fresh-input separate from cache
  // reads/writes, and total billable input = sum of the three. NULL on
  // rows persisted before cache plumbing landed; 0 on Anthropic turns
  // where caching didn't fire. Non-Anthropic providers leave both NULL
  // until they grow the equivalent breakdown.
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  // Thinking/reasoning tokens (Gemini + OpenAI). Included in output_tokens
  // for billing; surfaced separately so the UI can show the breakdown.
  thinking_tokens: number | null;
  cost_usd: number | null;
}

export interface ThreadDetail extends ThreadSummary {
  messages: Message[];
  has_more: boolean;
  // Effective context-window size (in tokens) for this thread's current
  // agent + model config. Used by the chat UI to scale the per-turn
  // context-usage bar against the same cap the agent applies at run time.
  context_window_tokens?: number | null;
  // ADR-0042 — explicit context boundary + cached warm summary. NULL on
  // threads with no pin (the agent's history_window_hours default applies).
  // The summary is fresh iff `warm_summary_before === hot_since`; the chat
  // UI uses that comparison to decide whether to show the live summary or
  // a "will appear after your next reply" placeholder.
  hot_since?: string | null;
  warm_summary?: string | null;
  warm_summary_before?: string | null;
  warm_summary_computed_at?: string | null;
  // Compaction stats — drive the boundary chip's "N msgs · old → new chars"
  // readout. Null when the summary was produced before these columns existed.
  warm_summary_source_messages?: number | null;
  warm_summary_source_chars?: number | null;
}

export interface ThreadContextPin {
  hot_since: string | null;
  warm_summary: string | null;
  warm_summary_before: string | null;
  warm_summary_computed_at: string | null;
  warm_summary_source_messages: number | null;
  warm_summary_source_chars: number | null;
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
  // Linked credential row that carries api_key / base_url / extra_headers
  // (or OAuth tokens). NULL on freshly seeded rows; auto-migration fills
  // this for legacy rows that had inline secrets.
  credential_id?: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface ModelConfigIn {
  provider: string;
  model_id: string;
  params?: ModelConfig["params"];
  credential_id?: string | null;
  is_default?: boolean;
}

export type CredentialType = "model" | "tts" | "integration" | "bridge";
export type CredentialAuthMethod = "api_key" | "oauth";

export interface Credential {
  id: string;
  type: CredentialType;
  provider: string;
  auth_method: CredentialAuthMethod;
  /**
   * Human-readable name shown in the UI ("Work", "Personal", …). `null`
   * = the renderer falls back to the `id`. Multiple credentials may share
   * a label — uniqueness is on `id` only.
   */
  label: string | null;
  /**
   * `true` = the implicit pick for callers that don't reference a specific
   * credential id (back-compat with the legacy single-instance flows).
   * Exactly one credential per (type, provider) carries `true`.
   */
  is_default: boolean;
  // Server returns this with secret fields redacted to "***" when
  // present. Clients never see plaintext for `api_key`/`client_secret`/
  // `refresh_token`/`access_token` — only their existence.
  params: {
    api_key?: string;
    base_url?: string;
    extra_headers?: Record<string, string>;
    client_id?: string;
    client_secret?: string;
    refresh_token?: string;
    access_token?: string;
    expires_at?: string;
  };
  created_at: string;
  updated_at: string;
}

export interface CredentialIn {
  // Omit to let the server allocate `<type>-<provider>[-N]`.
  id?: string;
  type: CredentialType;
  provider: string;
  auth_method?: CredentialAuthMethod;
  label?: string | null;
  // Server promotes this row to default for its (type, provider) pair.
  // The first row of a pair is always promoted regardless of this value.
  is_default?: boolean;
  params?: Credential["params"];
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
  // Back-compat: pre-rename clients may still send "normal" / "advanced".
  // Server-side normalization lives in lib/agents/run-thread.ts.
  ui_experience_mode?: "essential" | "full" | "normal" | "advanced";
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
  /** "builtin" = shipped with Jarela; "external" = loaded from JARELA_TOOLS_DIR; "mcp" = MCP server. */
  source?: "builtin" | "external" | "mcp";
  /** UI grouping label (e.g. "Files", "Web", "MCP"). */
  category?: string;
  /** Safety class: read-only inspection, content mutation, or external/workflow execution. */
  capability?: "read" | "write" | "execute";
  /**
   * Optional parent group rendered above the category in the Agent editor.
   * Currently used to collapse vendor-native categories (Atlassian, GitHub)
   * under a single "Work" header. `null` (or absent) means render flat.
   */
  group?: string | null;
  /**
   * Credential keys this tool requires before it can run. Declared by
   * external (.cjs) tools via `credentials_required: ["my_api_key"]` and by
   * MCP tools via the same field in their tool annotations. The agent config
   * panel shows a key icon on the tool checkbox when this is non-empty.
   */
  credentials_required?: string[];
  stats?: ToolUsefulnessStats;
  failure_samples?: ToolFailureSampleInfo[];
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

export interface ToolFailureSampleInfo {
  normalized_reason: string;
  count: number;
  last_seen_at: string;
}

export interface DashboardTierTokens {
  hot_tokens: number;
  warm_tokens: number;
  facts_tokens: number;
  overhead_tokens: number;
  measured_input_tokens: number;
}

export interface DashboardDataQuality {
  measured_messages: number;
  estimated_messages: number;
  measured_pct: number;
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
  tier_tokens: DashboardTierTokens;
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
  inferred: boolean;
  confidence: "high" | "medium" | "low";
  ok: boolean;
  status: number | null;
  error: string | null;
}

export interface DashboardModelRate {
  provider: string;
  model_id: string;
  input_per_1m_usd: number | null;
  output_per_1m_usd: number | null;
  source: string;
  inferred: boolean;
  confidence: "high" | "medium" | "low";
  ok: boolean;
  status: number | null;
  error: string | null;
}

export interface DashboardProviderBreakdown {
  provider: string;
  message_count: number;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
}

export interface DashboardModelBreakdown {
  model_config_name: string;
  provider: string;
  model_id: string;
  message_count: number;
  input_tokens_est: number;
  output_tokens_est: number;
  estimated_cost_usd: number;
}

export interface DashboardDayBreakdown {
  day: string;
  summary: {
    input_tokens_est: number;
    output_tokens_est: number;
    estimated_cost_usd: number;
    tool_calls: number;
    tool_successes: number;
    tool_errors: number;
    success_rate: number;
    error_rate: number;
    tier_tokens: DashboardTierTokens;
  };
  top_agents: DashboardAgentTop[];
  by_provider: DashboardProviderBreakdown[];
  by_model: DashboardModelBreakdown[];
}

export interface DashboardMetrics {
  generated_at: string;
  days: number;
  summary: {
    input_tokens_est: number;
    output_tokens_est: number;
    estimated_cost_usd: number;
    cache_read_tokens: number;
    cache_hit_rate: number;
    tool_calls: number;
    tool_successes: number;
    tool_errors: number;
    success_rate: number;
    error_rate: number;
    tier_tokens: DashboardTierTokens;
    data_quality: DashboardDataQuality;
  };
  series: DashboardSeriesPoint[];
  top_tools: DashboardToolTop[];
  top_agents: DashboardAgentTop[];
  by_provider: DashboardProviderBreakdown[];
  by_model: DashboardModelBreakdown[];
  breakdowns_by_day: Record<string, DashboardDayBreakdown>;
  pricing: {
    snapshot_generated_at: string | null;
    rates: DashboardProviderRate[];
    model_rates: DashboardModelRate[];
    notes: string;
  };
}

export interface DashboardCurrencyInfo {
  currency: string;
  rate_from_usd: number;
  country_code: string | null;
  source: "location" | "default" | "manual";
  updated_at: string;
}

export interface DashboardPricingRefreshResult {
  refreshed: boolean;
  reason: "forced" | "stale" | "missing" | "fresh";
  generated_at: string;
  ttl_days: number;
  source_count: number;
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
  | { type: "status"; phase: "starting" | "preparing" | "thinking"; label: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: unknown }
  // Zero or more of these can arrive between a call's "tool_call" and
  // "tool_result" — incremental status from inside a still-running tool
  // (e.g. claude_delegate relaying the sub-agent's own turns). `id` matches
  // the same call's "tool_call"/"tool_result" id.
  | { type: "tool_progress"; id: string; name: string; text: string }
  | { type: "done"; message_id: string; usage: { input_tokens: number; output_tokens: number } }
  | { type: "error"; message: string; code: string; credential_id?: string; provider?: string }
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
  event_subscriptions: {
    group_profile_updates: boolean;
    group_participants_updates: boolean;
  };
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
  event_subscriptions?: {
    group_profile_updates?: boolean;
    group_participants_updates?: boolean;
  };
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
// Bridge ignore list — per-bridge chat blocklist
// ---------------------------------------------------------------------------

/**
 * A chat blocked from ever entering the agent pipeline on this bridge.
 * When an entry exists, the router returns null for inbound messages
 * from `remote_jid` regardless of whether an explicit route or catch-all
 * would otherwise match — no thread history, no memory writes, no tools.
 * Delete the entry to resume forwarding.
 */
export interface BridgeIgnore {
  id: string;
  bridge_id: string;
  remote_jid: string;
  label: string | null;      // captured at add time so the UI can name the chat later
  created_at: string;
}

export interface BridgeIgnoreIn {
  remote_jid: string;        // exact JID; '*' is rejected server-side
  label?: string | null;
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

// A host the user has approved the agent to use as them. The single
// approval grants both browser-RPC navigation and cookie passthrough.
// Cookie values never appear here — only `has_cookies` and the timestamps.
export interface AllowedSiteStatus {
  hostname: string;
  ssrf_bypass: boolean;
  has_cookies: boolean;
  created_at: string;
  last_used_at: string | null;
  cookies_updated_at: string | null;
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

// External drop-in provider (a .cjs file in PROVIDERS_DIR). When the module
// declares `credentials`, the provider gains a first-class entry in the
// Credentials panel and the model-editor credential picker just like native
// providers (Anthropic, OpenAI, etc.).
export interface ExternalProviderInfo extends ExtensionInfo {
  label: string;
  description: string;
  credentials: IntegrationField[];
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

// A non-secret configuration slot declared by an external tool. The current
// value is returned directly (not masked) since config is not sensitive.
export interface ToolConfigSlotInfo {
  key: string;
  label?: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: string;
  description?: string;
  value: string | null;
}

export interface ExternalToolInfo extends ExtensionInfo {
  description: string;
  category: string | null;
  enabled: boolean;
  secrets: ToolSecretSlotInfo[];
  config: ToolConfigSlotInfo[];
}

export interface ExtensionLoadError {
  kind: "provider" | "tool";
  file: string;
  error: string;
}

// Response from POST /api/v1/system/abort — soft reset that cancels every
// in-flight LangGraph run without exiting the process.
export interface SystemAbortResponse {
  aborted: number;
  reason: string;
}

// Response from POST /api/v1/system/restart — schedules process.exit(0)
// ~250ms after responding so the supervisor can relaunch.
export interface SystemRestartResponse {
  accepted: boolean;
  reason: string | null;
  hint: string;
}

export interface ExtensionsListResponse {
  directories: { providers: string; tools: string };
  providers: ExternalProviderInfo[];
  tools: ExternalToolInfo[];
  errors: ExtensionLoadError[];
}

/**
 * Hot-loaded vanilla LangChain tool packages. Surface for the
 * Tools → LangChain packages UI panel.
 */
export interface LangChainPackageManifest {
  package: string;
  export: string;
  category: string;
  capability: "read" | "write" | "execute";
  args?: Record<string, unknown>;
  requiredEnv?: string[];
}

export interface LangChainPackageManifestRecord {
  name: string;
  manifest: LangChainPackageManifest;
  enabled: boolean;
}

export interface LangChainPackageLoadResult {
  registered: string[];
  skipped: { manifest: string; reason: string }[];
  errors: { manifest: string; error: string }[];
}

export interface LangChainPackageListResponse extends LangChainPackageLoadResult {
  packagesDir: string;
  defaults: DefaultLangChainPackageInfo[];
}

export interface DefaultLangChainPackageInfo {
  id: string;
  label: string;
  category: string;
  integrationId: string;
  npmPackage: string;
  toolCounts: { read: number; write: number; execute: number };
  description: string;
  enabled: boolean;
}

export interface LangChainPackageManifestInput {
  name: string;
  package: string;
  export?: string;
  category: string;
  capability?: "read" | "write" | "execute";
  args?: Record<string, unknown>;
  requiredEnv?: string[];
}

export interface LangChainPackagePendingInstall {
  id: string;
  spec: string;
  version: string | null;
  publisher: string;
  reason: string;
  createdAt: string;
}

export interface LangChainPackageIntrospectedTool {
  export: string;
  name: string;
  description: string;
  requiredEnv: string[];
}

export interface LangChainPackageInstallResult {
  status: "installed";
  spec: string;
  publisher: string;
  resolvedPackage: string;
  installedVersion: string | null;
  tools: LangChainPackageIntrospectedTool[];
}

export interface LangChainPackagePendingResponse {
  status: "pending";
  approvalId: string;
  publisher: string;
  spec: string;
  reason: string;
}

export type LangChainPackageInstallResponse =
  | LangChainPackageInstallResult
  | LangChainPackagePendingResponse;

export interface LangChainPackageManifestCreateResult {
  record: LangChainPackageManifestRecord;
  load: LangChainPackageLoadResult;
}

export interface LangChainCatalogEntry {
  id: string;
  label: string;
  npmPackage: string;
  manifestPackage?: string;
  exportName: string;
  description: string;
  category: string;
  capability?: "read" | "write" | "execute";
  requiredEnv?: string[];
  docsUrl?: string;
}

export interface LangChainCatalogResponse {
  entries: LangChainCatalogEntry[];
}
