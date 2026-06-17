// Central runtime configuration, resolved from environment variables.
//
// All operational knobs (port, host, data dir, timeouts, agent limits) flow
// through this module so there is exactly one place documenting which env
// vars Jarela respects and what the defaults are. Code MUST NOT read these
// `process.env` keys directly — import `config` instead.
//
// Resolution order for every entry: explicit JARELA_* var → legacy/standard
// var (where one exists, e.g. PORT/HOSTNAME for Next.js compatibility) →
// schema default (lib/env/schema.ts).
//
// Values are resolved lazily on first read and cached. Tests + the env-
// override PATCH endpoint must call `resetConfigCache()` between cases.

import { getDataDir } from "@/lib/db/data-dir";
import { getAppName, getAppDescription, getAppIssueUrl } from "./app-config";
import { ENV_DEFAULTS } from "./schema";
import { join } from "node:path";
import { homedir } from "node:os";

export interface JarelaConfig {
  // network
  readonly port: number;
  readonly hostname: string;
  readonly dataDir: string;
  readonly toolsDir: string;
  readonly httpRequestTimeoutMs: number;
  readonly sseConnectTimeoutMs: number;
  readonly healthCheckTimeoutMs: number;
  readonly httpMaxAttempts: number;
  readonly allowPrivateFetch: boolean;

  // agent
  readonly recursionLimit: number;
  readonly llmStreamMaxMs: number;
  readonly runIdleMs: number;
  readonly runMaxMs: number;
  readonly runRegistryTtlMs: number;
  readonly runBufferSize: number;
  readonly maxStallRetries: number;
  readonly maxTransientRetries: number;
  readonly maxDelegationDepth: number;
  readonly streamParseTripwire: number;
  readonly recallBudgetMs: number;
  readonly warmSummaryBudgetMs: number;
  readonly maxThreadMessages: number;
  readonly maxSessionArchives: number;

  // tools
  readonly voiceTimeoutMs: number;
  readonly imageTimeoutMs: number;
  readonly fetchToolMaxBytes: number;
  readonly mcpRegistryTimeoutMs: number;
  readonly execMaxOutputBytes: number;
  readonly filesMaxReadBytes: number;
  readonly filesMaxWriteBytes: number;

  // lifecycle
  readonly updateCheckTimeoutMs: number;
  readonly shutdownDrainMs: number;
  readonly shutdownSettleMs: number;
  readonly disableUpdateCheck: boolean;

  // limits
  readonly notificationRingSize: number;

  // logging
  readonly logsRingSize: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";

  // scheduler
  readonly schedulerTickMs: number;
  readonly fastRemoteSweepMs: number;

  // documents
  readonly docMaxFileBytes: number;
  readonly docMaxFilesPerSource: number;
  readonly pricingLlmExtract: boolean;
  readonly pricingExtractorModel: string;

  // providers
  readonly enableMockProvider: boolean;

  // anti-hallucination detector
  readonly hallucinationDetectorMode: "off" | "regex" | "model";
  readonly hallucinationDetectorModel: string;
  readonly citationCheckerTailChars: number;
  readonly citationManifestMax: number;

  // app metadata
  readonly appName: string;
  readonly appDescription: string;
  readonly issueUrl: string;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Like parsePositiveInt but accepts 0 as a valid value (used to disable
// deadlines explicitly). Negative / NaN still fall through to the default.
function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function parsePort(value: string | undefined, fallback: number): number {
  const n = parsePositiveInt(value, fallback);
  return n >= 1 && n <= 65_535 ? n : fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return fallback;
}

function parseHallucinationMode(
  value: string | undefined,
  fallback: JarelaConfig["hallucinationDetectorMode"],
): JarelaConfig["hallucinationDetectorMode"] {
  if (!value) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "off" || v === "regex" || v === "model") return v;
  return fallback;
}

function parseLogLevel(value: string | undefined, fallback: "debug" | "info" | "warn" | "error"): JarelaConfig["logLevel"] {
  if (!value) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return fallback;
}

let cached: JarelaConfig | null = null;

function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

export function getConfig(): JarelaConfig {
  if (cached) return cached;
  const env = process.env;
  const dataDir = getDataDir();
  cached = {
    // network
    port: parsePort(env.JARELA_PORT ?? env.PORT, ENV_DEFAULTS.port),
    hostname: (env.JARELA_HOSTNAME ?? env.HOSTNAME ?? ENV_DEFAULTS.hostname).trim() || ENV_DEFAULTS.hostname,
    dataDir,
    toolsDir: env.JARELA_TOOLS_DIR ? expandHome(env.JARELA_TOOLS_DIR) : join(dataDir, "tools"),
    httpRequestTimeoutMs: parsePositiveInt(env.JARELA_HTTP_REQUEST_TIMEOUT_MS, ENV_DEFAULTS.httpRequestTimeoutMs),
    sseConnectTimeoutMs: parsePositiveInt(env.JARELA_SSE_CONNECT_TIMEOUT_MS, ENV_DEFAULTS.sseConnectTimeoutMs),
    healthCheckTimeoutMs: parsePositiveInt(env.JARELA_HEALTH_CHECK_TIMEOUT_MS, ENV_DEFAULTS.healthCheckTimeoutMs),
    httpMaxAttempts: parsePositiveInt(env.JARELA_HTTP_MAX_ATTEMPTS, ENV_DEFAULTS.httpMaxAttempts),
    allowPrivateFetch: parseBool(env.JARELA_ALLOW_PRIVATE_FETCH, ENV_DEFAULTS.allowPrivateFetch),

    // agent
    recursionLimit: parsePositiveInt(env.JARELA_RECURSION_LIMIT, ENV_DEFAULTS.recursionLimit),
    llmStreamMaxMs: parseNonNegativeInt(env.JARELA_LLM_STREAM_MAX_MS, ENV_DEFAULTS.llmStreamMaxMs),
    runIdleMs: parsePositiveInt(env.JARELA_RUN_IDLE_MS, ENV_DEFAULTS.runIdleMs),
    runMaxMs: parsePositiveInt(env.JARELA_RUN_MAX_MS, ENV_DEFAULTS.runMaxMs),
    runRegistryTtlMs: parsePositiveInt(env.JARELA_RUN_REGISTRY_TTL_MS, ENV_DEFAULTS.runRegistryTtlMs),
    runBufferSize: parsePositiveInt(env.JARELA_RUN_BUFFER_SIZE, ENV_DEFAULTS.runBufferSize),
    maxStallRetries: parseNonNegativeInt(env.JARELA_MAX_STALL_RETRIES, ENV_DEFAULTS.maxStallRetries),
    maxTransientRetries: parseNonNegativeInt(env.JARELA_MAX_TRANSIENT_RETRIES, ENV_DEFAULTS.maxTransientRetries),
    maxDelegationDepth: parseNonNegativeInt(env.JARELA_MAX_DELEGATION_DEPTH, ENV_DEFAULTS.maxDelegationDepth),
    streamParseTripwire: parsePositiveInt(env.JARELA_STREAM_PARSE_TRIPWIRE, ENV_DEFAULTS.streamParseTripwire),
    recallBudgetMs: parseNonNegativeInt(env.JARELA_RECALL_BUDGET_MS, ENV_DEFAULTS.recallBudgetMs),
    warmSummaryBudgetMs: parseNonNegativeInt(env.JARELA_WARM_SUMMARY_BUDGET_MS, ENV_DEFAULTS.warmSummaryBudgetMs),
    maxThreadMessages: parsePositiveInt(env.JARELA_MAX_THREAD_MESSAGES, ENV_DEFAULTS.maxThreadMessages),
    maxSessionArchives: parsePositiveInt(env.JARELA_MAX_SESSION_ARCHIVES, ENV_DEFAULTS.maxSessionArchives),

    // tools
    voiceTimeoutMs: parsePositiveInt(env.JARELA_VOICE_TIMEOUT_MS, ENV_DEFAULTS.voiceTimeoutMs),
    imageTimeoutMs: parsePositiveInt(env.JARELA_IMAGE_TIMEOUT_MS, ENV_DEFAULTS.imageTimeoutMs),
    fetchToolMaxBytes: parsePositiveInt(env.JARELA_FETCH_TOOL_MAX_BYTES, ENV_DEFAULTS.fetchToolMaxBytes),
    mcpRegistryTimeoutMs: parsePositiveInt(env.JARELA_MCP_REGISTRY_TIMEOUT_MS, ENV_DEFAULTS.mcpRegistryTimeoutMs),
    execMaxOutputBytes: parsePositiveInt(env.JARELA_EXEC_MAX_OUTPUT_BYTES, ENV_DEFAULTS.execMaxOutputBytes),
    filesMaxReadBytes: parsePositiveInt(env.JARELA_FILES_MAX_READ_BYTES, ENV_DEFAULTS.filesMaxReadBytes),
    filesMaxWriteBytes: parsePositiveInt(env.JARELA_FILES_MAX_WRITE_BYTES, ENV_DEFAULTS.filesMaxWriteBytes),

    // lifecycle
    updateCheckTimeoutMs: parsePositiveInt(env.JARELA_UPDATE_CHECK_TIMEOUT_MS, ENV_DEFAULTS.updateCheckTimeoutMs),
    shutdownDrainMs: parsePositiveInt(env.JARELA_SHUTDOWN_DRAIN_MS, ENV_DEFAULTS.shutdownDrainMs),
    shutdownSettleMs: parseNonNegativeInt(env.JARELA_SHUTDOWN_SETTLE_MS, ENV_DEFAULTS.shutdownSettleMs),
    disableUpdateCheck: parseBool(env.JARELA_DISABLE_UPDATE_CHECK, false),

    // limits
    notificationRingSize: parsePositiveInt(env.JARELA_NOTIFICATION_RING_SIZE, ENV_DEFAULTS.notificationRingSize),

    // logging
    logsRingSize: parsePositiveInt(env.JARELA_LOGS_RING_SIZE, ENV_DEFAULTS.logsRingSize),
    logLevel: parseLogLevel(env.JARELA_LOG_LEVEL, ENV_DEFAULTS.logLevel),

    // scheduler
    schedulerTickMs: parsePositiveInt(env.JARELA_SCHEDULER_TICK_MS, ENV_DEFAULTS.schedulerTickMs),
    fastRemoteSweepMs: parsePositiveInt(env.JARELA_FAST_REMOTE_SWEEP_MS, ENV_DEFAULTS.fastRemoteSweepMs),

    // documents
    docMaxFileBytes: parsePositiveInt(env.JARELA_DOC_MAX_FILE_BYTES, ENV_DEFAULTS.docMaxFileBytes),
    docMaxFilesPerSource: parsePositiveInt(env.JARELA_DOC_MAX_FILES_PER_SOURCE, ENV_DEFAULTS.docMaxFilesPerSource),
    pricingLlmExtract: parseBool(env.JARELA_PRICING_LLM_EXTRACT, ENV_DEFAULTS.pricingLlmExtract),
    pricingExtractorModel: (env.JARELA_PRICING_EXTRACTOR_MODEL ?? ENV_DEFAULTS.pricingExtractorModel).trim(),

    // providers
    enableMockProvider: parseBool(env.JARELA_ENABLE_MOCK_PROVIDER, ENV_DEFAULTS.enableMockProvider),

    // anti-hallucination classifier
    hallucinationDetectorMode: parseHallucinationMode(
      env.JARELA_HALLUCINATION_DETECTOR_MODE,
      ENV_DEFAULTS.hallucinationDetectorMode,
    ),
    hallucinationDetectorModel: (env.JARELA_HALLUCINATION_DETECTOR_MODEL ?? ENV_DEFAULTS.hallucinationDetectorModel).trim(),
    citationCheckerTailChars: parseNonNegativeInt(env.JARELA_CITATION_CHECKER_TAIL_CHARS, ENV_DEFAULTS.citationCheckerTailChars),
    citationManifestMax: parseNonNegativeInt(env.JARELA_CITATION_MANIFEST_MAX, ENV_DEFAULTS.citationManifestMax),

    // app metadata
    appName: getAppName(),
    appDescription: getAppDescription(),
    issueUrl: getAppIssueUrl(),
  };
  return cached;
}

/** Drop the memoised config so the next read picks up env edits. Used by tests + the env-override PATCH endpoint. */
export function resetConfigCache(): void {
  cached = null;
}
