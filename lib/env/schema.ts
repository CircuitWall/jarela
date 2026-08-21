// Single source of truth for every JARELA_* environment variable Jarela
// respects at runtime. The schema drives:
//
//   - lib/env/config.ts       — typed snapshot via getConfig()
//   - lib/env/overrides.ts    — boot-time injection of persisted overrides
//   - app/api/v1/env/route.ts — REST surface for the EnvVarsPanel UI
//   - lib/tools/set_env_var.ts — agent-callable env edit (gated)
//
// Adding a new knob is a single edit here: append an entry to ENV_SCHEMA
// with name/type/default/description/tier and the rest of the system
// (UI, persistence, agent tool gating, docs) picks it up automatically.

export type EnvVarType = "int" | "string" | "bool" | "enum";

export type EnvCategory =
  | "network"      // bind, ports, HTTP request shape
  | "agent"        // run loop, retries, recursion
  | "tools"        // tool execution, sandbox, I/O caps
  | "lifecycle"    // boot, shutdown, update-check
  | "limits"       // ring buffers, page sizes
  | "logging"      // log level, sink size
  | "scheduler"    // cron tick, sweeps
  | "documents"    // doc indexer + remote sync
  | "providers"    // LLM provider selection / overrides
  | "ui";

export type EnvTier = "A" | "B" | "C";

export interface EnvVarDef {
  /** Process env name, e.g. "JARELA_TOOL_TIMEOUT_MS". */
  readonly name: string;
  readonly type: EnvVarType;
  readonly default: number | string | boolean;
  readonly description: string;
  readonly category: EnvCategory;
  /**
   * Tier A — sysadmin / proxy / common ops; B — advanced; C — internal /
   * rarely useful. The UI surfaces A by default and gates B/C behind a
   * "Show advanced" toggle.
   */
  readonly tier: EnvTier;
  /**
   * True when changing this requires a server restart to take effect
   * (bind-time vars, anything captured into a closure at module load).
   * The UI shows a "restart needed" badge on these rows.
   */
  readonly requiresRestart: boolean;
  /**
   * True when the set_env_var agent tool may change this. Default false —
   * agents shouldn't be poking at infra knobs. Opt-in per var.
   */
  readonly agentWritable: boolean;
  /** For type === "int": clamp range. */
  readonly min?: number;
  readonly max?: number;
  /** For type === "enum": permitted values. */
  readonly enumValues?: readonly string[];
  /**
   * Sensitive values are masked in the UI (display "*****" not the value).
   * Used for credential-style env vars if any ever land in this schema.
   * Most JARELA_* vars are operational knobs, not secrets.
   */
  readonly sensitive?: boolean;
}

// Default values centralized so config.ts stays a thin facade.
export const ENV_DEFAULTS = {
  // network
  port: 4312,
  hostname: "127.0.0.1",
  httpRequestTimeoutMs: 45_000,
  sseConnectTimeoutMs: 45_000,
  healthCheckTimeoutMs: 8_000,
  httpMaxAttempts: 3,
  allowPrivateFetch: false,
  // agent
  recursionLimit: 200,
  llmStreamMaxMs: 10 * 60_000,
  runIdleMs: 120_000,
  runMaxMs: 20 * 60_000,
  runRegistryTtlMs: 5 * 60_000,
  runBufferSize: 4000,
  maxStallRetries: 1,
  maxTransientRetries: 1,
  maxDelegationDepth: 2,
  streamParseTripwire: 6,
  recallBudgetMs: 1500,
  warmSummaryBudgetMs: 5000,
  maxThreadMessages: 1000,
  maxSessionArchives: 50,
  // tools
  voiceTimeoutMs: 60_000,
  imageTimeoutMs: 60_000,
  fetchToolMaxBytes: 2_000_000,
  mcpRegistryTimeoutMs: 15_000,
  execMaxOutputBytes: 8_000,
  filesMaxReadBytes: 64_000,
  filesMaxWriteBytes: 2_000_000,
  // lifecycle
  updateCheckTimeoutMs: 3_000,
  shutdownDrainMs: 10_000,
  shutdownSettleMs: 3_000,
  // limits
  notificationRingSize: 50,
  // logging
  logsRingSize: 2000,
  logLevel: "info",
  // scheduler
  schedulerTickMs: 30_000,
  fastRemoteSweepMs: 60_000,
  // documents
  docMaxFileBytes: 2 * 1024 * 1024,
  docMaxFilesPerSource: 5_000,
  pricingLlmExtract: true,
  pricingExtractorModel: "",
  // providers
  enableMockProvider: false,
  // tool safety / policy (already in lib/env/allowlist; kept for schema completeness)
  toolSafety: "mostly_safe" as const,
  // anti-hallucination classifier
  hallucinationDetectorMode: "regex" as const,
  hallucinationDetectorModel: "",
  modelRouterMode: "off" as const,
  modelRouterPolicy: "balanced" as const,
  perfTelemetryEnabled: false,
  // citation checker (second-pass LLM on agents with citation_strictness != 'off')
  citationCheckerTailChars: 4_000,
  // numbered source manifest shown to agents with citation_strictness != 'off'
  citationManifestMax: 50,
  // terminal sessions
  terminalMaxSessions: 5,
  terminalIdleTtlMs: 600_000,
} as const;

export const HALLUCINATION_DETECTOR_MODES = ["off", "regex", "model"] as const;
export const MODEL_ROUTER_MODES = ["off", "heuristic"] as const;
export const MODEL_ROUTER_POLICIES = ["cheap", "fast", "balanced", "quality"] as const;

export const TOOL_SAFETY_VALUES = ["safe", "mostly_safe", "bypass"] as const;
export const LOG_LEVEL_VALUES = ["debug", "info", "warn", "error"] as const;

export const ENV_SCHEMA: readonly EnvVarDef[] = [
  // ─── network ───────────────────────────────────────────────────────
  {
    name: "JARELA_PORT",
    type: "int",
    default: ENV_DEFAULTS.port,
    description: "TCP port the Next.js server binds to.",
    category: "network",
    tier: "A",
    requiresRestart: true,
    agentWritable: false,
    min: 1,
    max: 65_535,
  },
  {
    name: "JARELA_HOSTNAME",
    type: "string",
    default: ENV_DEFAULTS.hostname,
    description: "Bind address. 127.0.0.1 keeps the server loopback-only; 0.0.0.0 exposes it.",
    category: "network",
    tier: "A",
    requiresRestart: true,
    agentWritable: false,
  },
  {
    name: "JARELA_HTTP_REQUEST_TIMEOUT_MS",
    type: "int",
    default: ENV_DEFAULTS.httpRequestTimeoutMs,
    description: "Per-fetch deadline for browser → server API calls.",
    category: "network",
    tier: "A",
    requiresRestart: false,
    agentWritable: false,
    min: 1_000,
  },
  {
    name: "JARELA_SSE_CONNECT_TIMEOUT_MS",
    type: "int",
    default: ENV_DEFAULTS.sseConnectTimeoutMs,
    description: "How long to wait for an EventSource onopen before declaring the server unreachable.",
    category: "network",
    tier: "A",
    requiresRestart: false,
    agentWritable: false,
    min: 1_000,
  },
  {
    name: "JARELA_HEALTH_CHECK_TIMEOUT_MS",
    type: "int",
    default: ENV_DEFAULTS.healthCheckTimeoutMs,
    description: "Server-status widget probe deadline.",
    category: "network",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 500,
  },
  {
    name: "JARELA_HTTP_MAX_ATTEMPTS",
    type: "int",
    default: ENV_DEFAULTS.httpMaxAttempts,
    description: "Max attempts for retryable browser → server requests (network errors, 5xx, 429).",
    category: "network",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 1,
    max: 10,
  },
  {
    name: "JARELA_ALLOW_PRIVATE_FETCH",
    type: "bool",
    default: ENV_DEFAULTS.allowPrivateFetch,
    description: "Allow agent-driven fetches to private/loopback/link-local IPs (SSRF escape hatch). Off by default; set to 1 only when running against a local mock server.",
    category: "network",
    tier: "A",
    requiresRestart: false,
    agentWritable: false,
  },

  // ─── agent ─────────────────────────────────────────────────────────
  {
    name: "JARELA_RECURSION_LIMIT",
    type: "int",
    default: ENV_DEFAULTS.recursionLimit,
    description: "Max LangGraph node visits per agent run before the loop is killed.",
    category: "agent",
    tier: "A",
    requiresRestart: false,
    agentWritable: false,
    min: 10,
  },
  {
    name: "JARELA_LLM_STREAM_MAX_MS",
    type: "int",
    default: ENV_DEFAULTS.llmStreamMaxMs,
    description: "Wall-clock deadline for one agent.stream() invocation. Set 0 to disable.",
    category: "agent",
    tier: "A",
    requiresRestart: false,
    agentWritable: false,
    min: 0,
  },
  {
    name: "JARELA_RUN_IDLE_MS",
    type: "int",
    default: ENV_DEFAULTS.runIdleMs,
    description: "Idle watchdog: force-finish a run if no chunk has broadcasted for this long.",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: true,
    min: 1_000,
  },
  {
    name: "JARELA_RUN_MAX_MS",
    type: "int",
    default: ENV_DEFAULTS.runMaxMs,
    description: "Absolute wall-clock ceiling per run (safety net above the per-stream deadline).",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 60_000,
  },
  {
    name: "JARELA_RUN_REGISTRY_TTL_MS",
    type: "int",
    default: ENV_DEFAULTS.runRegistryTtlMs,
    description: "How long a finished run stays subscribable in the registry before TTL eviction.",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 60_000,
  },
  {
    name: "JARELA_RUN_BUFFER_SIZE",
    type: "int",
    default: ENV_DEFAULTS.runBufferSize,
    description: "Per-run chunk buffer cap before the oldest deltas are dropped from replay.",
    category: "agent",
    tier: "B",
    requiresRestart: true,
    agentWritable: false,
    min: 100,
  },
  {
    name: "JARELA_MAX_STALL_RETRIES",
    type: "int",
    default: ENV_DEFAULTS.maxStallRetries,
    description: "Retry budget for runs killed by the idle watchdog.",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: true,
    min: 0,
    max: 5,
  },
  {
    name: "JARELA_MAX_TRANSIENT_RETRIES",
    type: "int",
    default: ENV_DEFAULTS.maxTransientRetries,
    description: "Retry budget for transient provider failures (network/5xx/rate-limit).",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: true,
    min: 0,
    max: 5,
  },
  {
    name: "JARELA_MAX_DELEGATION_DEPTH",
    type: "int",
    default: ENV_DEFAULTS.maxDelegationDepth,
    description: "Max depth of agent → sub-agent delegation chains.",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 0,
    max: 10,
  },
  {
    name: "JARELA_STREAM_PARSE_TRIPWIRE",
    type: "int",
    default: ENV_DEFAULTS.streamParseTripwire,
    description: "Consecutive malformed-stream-chunk threshold before the stream is failed.",
    category: "agent",
    tier: "C",
    requiresRestart: false,
    agentWritable: false,
    min: 1,
  },
  {
    name: "JARELA_RECALL_BUDGET_MS",
    type: "int",
    default: ENV_DEFAULTS.recallBudgetMs,
    description: "Wall-clock budget for the embedding-based recall pass before the LLM stream starts without it. Higher = more memory hits but slower first-token; lower = faster but recall silently loses on cold embedding calls.",
    category: "agent",
    tier: "C",
    requiresRestart: false,
    agentWritable: false,
    min: 0,
  },
  {
    name: "JARELA_WARM_SUMMARY_BUDGET_MS",
    type: "int",
    default: ENV_DEFAULTS.warmSummaryBudgetMs,
    description: "Wall-clock cap on the warm-tier conversation summary LLM call inside prepareThreadRun. Past this budget the turn proceeds with no warm summary so a slow or hung summariser provider cannot stall the entire chat session.",
    category: "agent",
    tier: "C",
    requiresRestart: false,
    agentWritable: false,
    min: 0,
  },
  {
    name: "JARELA_MAX_THREAD_MESSAGES",
    type: "int",
    default: ENV_DEFAULTS.maxThreadMessages,
    description: "Upper bound on retained messages per thread. /compact prunes the oldest rows past this cap so long-lived threads don't grow without limit.",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 1,
  },
  {
    name: "JARELA_MAX_SESSION_ARCHIVES",
    type: "int",
    default: ENV_DEFAULTS.maxSessionArchives,
    description: "Upper bound on archived session summaries per agent. /compact drops oldest sessions/<agent>/* memory rows past this cap.",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 1,
  },

  // ─── tools ─────────────────────────────────────────────────────────
  // Per-tool wall-clock deadlines are agent-controlled via the
  // `deadline_ms` field on every tool's schema (see lib/tools/wallclock.ts).
  // No operator knob to clamp them — the model picks per call.
  {
    name: "JARELA_VOICE_TIMEOUT_MS",
    type: "int",
    default: ENV_DEFAULTS.voiceTimeoutMs,
    description: "Per-request timeout for Gemini voice (TTS/STT) calls.",
    category: "tools",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 1_000,
  },
  {
    name: "JARELA_IMAGE_TIMEOUT_MS",
    type: "int",
    default: ENV_DEFAULTS.imageTimeoutMs,
    description: "Per-request timeout for Gemini image-generation calls.",
    category: "tools",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 1_000,
  },
  {
    name: "JARELA_FETCH_TOOL_MAX_BYTES",
    type: "int",
    default: ENV_DEFAULTS.fetchToolMaxBytes,
    description: "Max body size returned by the fetch tool before truncation.",
    category: "tools",
    tier: "A",
    requiresRestart: false,
    agentWritable: false,
    min: 4_096,
  },
  {
    name: "JARELA_MCP_REGISTRY_TIMEOUT_MS",
    type: "int",
    default: ENV_DEFAULTS.mcpRegistryTimeoutMs,
    description: "MCP upstream-registry discovery fetch timeout.",
    category: "tools",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 1_000,
  },
  {
    name: "JARELA_EXEC_MAX_OUTPUT_BYTES",
    type: "int",
    default: ENV_DEFAULTS.execMaxOutputBytes,
    description: "Cap on captured stdout+stderr from exec tools before truncation.",
    category: "tools",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 1_024,
  },
  {
    name: "JARELA_FILES_MAX_READ_BYTES",
    type: "int",
    default: ENV_DEFAULTS.filesMaxReadBytes,
    description: "Max bytes returned by the read_file tool per call.",
    category: "tools",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 1_024,
  },
  {
    name: "JARELA_FILES_MAX_WRITE_BYTES",
    type: "int",
    default: ENV_DEFAULTS.filesMaxWriteBytes,
    description: "Max bytes accepted by the write_file tool per call.",
    category: "tools",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 1_024,
  },
  {
    name: "JARELA_TOOL_SAFETY",
    type: "enum",
    default: ENV_DEFAULTS.toolSafety,
    description: "Tool sandbox tier: safe (read-only), mostly_safe (default), bypass (full local exec).",
    category: "tools",
    tier: "A",
    requiresRestart: true,
    agentWritable: false,
    enumValues: TOOL_SAFETY_VALUES,
  },

  // ─── lifecycle ─────────────────────────────────────────────────────
  {
    name: "JARELA_UPDATE_CHECK_TIMEOUT_MS",
    type: "int",
    default: ENV_DEFAULTS.updateCheckTimeoutMs,
    description: "Deadline for the daily GitHub release-tag probe.",
    category: "lifecycle",
    tier: "C",
    requiresRestart: false,
    agentWritable: false,
    min: 500,
  },
  {
    name: "JARELA_SHUTDOWN_DRAIN_MS",
    type: "int",
    default: ENV_DEFAULTS.shutdownDrainMs,
    description: "Hard timeout for graceful-shutdown drain before forced exit.",
    category: "lifecycle",
    tier: "B",
    requiresRestart: true,
    agentWritable: false,
    min: 500,
  },
  {
    name: "JARELA_SHUTDOWN_SETTLE_MS",
    type: "int",
    default: ENV_DEFAULTS.shutdownSettleMs,
    description: "Wait budget for in-flight runs to settle during graceful shutdown.",
    category: "lifecycle",
    tier: "B",
    requiresRestart: true,
    agentWritable: false,
    min: 0,
  },
  {
    name: "JARELA_DISABLE_UPDATE_CHECK",
    type: "bool",
    default: false,
    description: "Skip the daily update probe entirely.",
    category: "lifecycle",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
  },
  {
    name: "JARELA_SKIP_INSTANCE_LOCK",
    type: "bool",
    default: false,
    description:
      "Bypass the single-instance PID-lock guard at boot. Reserved for dev-loop recovery; running two processes against the same SQLite DB corrupts state.",
    category: "lifecycle",
    tier: "C",
    requiresRestart: true,
    agentWritable: false,
  },

  // ─── limits ────────────────────────────────────────────────────────
  {
    name: "JARELA_NOTIFICATION_RING_SIZE",
    type: "int",
    default: ENV_DEFAULTS.notificationRingSize,
    description: "How many recent notification events the bus keeps for replay.",
    category: "limits",
    tier: "C",
    requiresRestart: true,
    agentWritable: false,
    min: 10,
  },

  // ─── logging ───────────────────────────────────────────────────────
  {
    name: "JARELA_LOGS_RING_SIZE",
    type: "int",
    default: ENV_DEFAULTS.logsRingSize,
    description: "Server-log ring buffer cap (entries kept for the Logs panel + /api/v1/logs).",
    category: "logging",
    tier: "B",
    requiresRestart: true,
    agentWritable: false,
    min: 100,
  },
  {
    name: "JARELA_LOG_LEVEL",
    type: "enum",
    default: ENV_DEFAULTS.logLevel,
    description: "Minimum level captured into the Logs panel ring (terminal output is never filtered).",
    category: "logging",
    tier: "B",
    requiresRestart: false,
    agentWritable: true,
    enumValues: LOG_LEVEL_VALUES,
  },

  // ─── scheduler ─────────────────────────────────────────────────────
  {
    name: "JARELA_SCHEDULER_TICK_MS",
    type: "int",
    default: ENV_DEFAULTS.schedulerTickMs,
    description: "Cron-driven background scheduler tick interval.",
    category: "scheduler",
    tier: "B",
    requiresRestart: true,
    agentWritable: false,
    min: 1_000,
  },
  {
    name: "JARELA_FAST_REMOTE_SWEEP_MS",
    type: "int",
    default: ENV_DEFAULTS.fastRemoteSweepMs,
    description: "Polling interval for remote document sources (Confluence/Jira/Mail/GitHub).",
    category: "scheduler",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 5_000,
  },

  // ─── documents ─────────────────────────────────────────────────────
  {
    name: "JARELA_DOC_MAX_FILE_BYTES",
    type: "int",
    default: ENV_DEFAULTS.docMaxFileBytes,
    description: "Max single-file size the document indexer will ingest.",
    category: "documents",
    tier: "A",
    requiresRestart: false,
    agentWritable: false,
    min: 1_024,
  },
  {
    name: "JARELA_DOC_MAX_FILES_PER_SOURCE",
    type: "int",
    default: ENV_DEFAULTS.docMaxFilesPerSource,
    description: "Cap on total files indexed from one source.",
    category: "documents",
    tier: "A",
    requiresRestart: false,
    agentWritable: false,
    min: 10,
  },
  {
    name: "JARELA_PRICING_LLM_EXTRACT",
    type: "bool",
    default: ENV_DEFAULTS.pricingLlmExtract,
    description: "Use an LLM to extract per-model rates from vendor pricing HTML when scraping. Set to 0 to disable LLM extraction (pricing falls back to known-rates only).",
    category: "documents",
    tier: "C",
    requiresRestart: false,
    agentWritable: false,
  },
  {
    name: "JARELA_PRICING_EXTRACTOR_MODEL",
    type: "string",
    default: ENV_DEFAULTS.pricingExtractorModel,
    description: "Model config name to use as the pricing-page extractor. Empty = the default model config. Pick a fast/cheap model with good HTML → JSON ability.",
    category: "documents",
    tier: "C",
    requiresRestart: false,
    agentWritable: false,
  },
  {
    name: "JARELA_ENABLE_MOCK_PROVIDER",
    type: "bool",
    default: ENV_DEFAULTS.enableMockProvider,
    description: "Register the in-process mock LLM provider as a selectable backend. Off by default so production deployments never expose it. Tests / offline dev set this.",
    category: "providers",
    tier: "C",
    requiresRestart: false,
    agentWritable: false,
  },
  {
    name: "JARELA_HALLUCINATION_DETECTOR_MODE",
    type: "enum",
    default: ENV_DEFAULTS.hallucinationDetectorMode,
    description: "Anti-hallucination detector. 'off' = no detection. 'regex' = pattern-based (default; fast, free, brittle). 'model' = LLM classifier (more accurate, costs one extra model call per agent turn). 'model' requires JARELA_HALLUCINATION_DETECTOR_MODEL to be set; if missing, falls back to 'regex'.",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    enumValues: HALLUCINATION_DETECTOR_MODES,
  },
  {
    name: "JARELA_HALLUCINATION_DETECTOR_MODEL",
    type: "string",
    default: ENV_DEFAULTS.hallucinationDetectorModel,
    description: "Model config name (from Models settings) to use as the anti-hallucination classifier. Pick a fast/cheap one (e.g. claude-haiku, gpt-4o-mini, gemini-flash). Empty = no classifier; the mode knob is effectively 'off'.",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
  },
  {
    name: "JARELA_MODEL_ROUTER_MODE",
    type: "enum",
    default: ENV_DEFAULTS.modelRouterMode,
    description: "Pre-run model router. 'off' keeps today's explicit-or-default model resolution. 'heuristic' chooses a saved model per turn using capability, cost, speed, and cache-affinity heuristics before the agent run starts.",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    enumValues: MODEL_ROUTER_MODES,
  },
  {
    name: "JARELA_MODEL_ROUTER_POLICY",
    type: "enum",
    default: ENV_DEFAULTS.modelRouterPolicy,
    description: "Optimization policy for the heuristic model router. 'cheap' minimizes spend, 'fast' biases low-latency families, 'balanced' trades off speed/cost/capability, and 'quality' escalates more readily to stronger models.",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    enumValues: MODEL_ROUTER_POLICIES,
  },
  {
    name: "JARELA_PERF_TELEMETRY_ENABLED",
    type: "bool",
    default: ENV_DEFAULTS.perfTelemetryEnabled,
    description: "Enable local-only run-performance telemetry logs (queue/prep/TTFT/stream/total). No external export.",
    category: "logging",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
  },
  {
    name: "JARELA_CITATION_CHECKER_TAIL_CHARS",
    type: "int",
    default: ENV_DEFAULTS.citationCheckerTailChars,
    description: "Max characters of the assistant reply sent to the citation checker (agents with citation_strictness != 'off'). Only the trailing N chars are sent so checker cost stays bounded. Set 0 to send the full reply — use when claims often appear early in long answers; costs more tokens per check.",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 0,
  },
  {
    name: "JARELA_CITATION_MANIFEST_MAX",
    type: "int",
    default: ENV_DEFAULTS.citationManifestMax,
    description: "Max numbered sources shown to agents with citation_strictness != 'off' as the citation manifest (most-recent N visited via tools in this thread, plus memory items and prior assistant turns). Agent cites a source by writing the marker [N] inline. 0 disables the manifest (agent will be told no sources are available to cite).",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 0,
  },
  {
    name: "JARELA_TERMINAL_MAX_SESSIONS",
    type: "int",
    default: ENV_DEFAULTS.terminalMaxSessions,
    description: "Max number of concurrent persistent terminal sessions. New session attempts beyond this limit are rejected.",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 1,
    max: 50,
  },
  {
    name: "JARELA_TERMINAL_IDLE_TTL_MS",
    type: "int",
    default: ENV_DEFAULTS.terminalIdleTtlMs,
    description: "Idle TTL for persistent terminal sessions. Sessions idle longer than this are automatically closed.",
    category: "agent",
    tier: "B",
    requiresRestart: false,
    agentWritable: false,
    min: 60_000,
  },
];

const SCHEMA_BY_NAME = new Map<string, EnvVarDef>(
  ENV_SCHEMA.map((entry) => [entry.name, entry] as const),
);

export function envSchemaByName(): ReadonlyMap<string, EnvVarDef> {
  return SCHEMA_BY_NAME;
}

export function envSchemaList(): readonly EnvVarDef[] {
  return ENV_SCHEMA;
}
