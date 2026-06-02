// Central runtime configuration, resolved from environment variables.
//
// All operational knobs (port, host, data dir, timeouts, agent limits) flow
// through this module so there is exactly one place documenting which env
// vars Jarela respects and what the defaults are. Code MUST NOT read these
// `process.env` keys directly — import `config` instead.
//
// Resolution order for every entry: explicit JARELA_* var → legacy/standard
// var (where one exists, e.g. PORT/HOSTNAME for Next.js compatibility) →
// hard-coded default.
//
// Values are resolved lazily on first read and cached. Tests that mutate
// `process.env` must call `resetConfigCache()` between cases.

import { getDataDir } from "@/lib/db/data-dir";
import { getAppName, getAppDescription, getAppIssueUrl } from "./app-config";
import { join } from "node:path";
import { homedir } from "node:os";

export interface JarelaConfig {
  /** TCP port the Next.js server binds to. */
  readonly port: number;
  /** Hostname/interface the server binds to (loopback by default). */
  readonly hostname: string;
  /** Absolute path to the SQLite + files data directory. */
  readonly dataDir: string;
  /** Absolute path to the external-tools directory (CJS/TS plugins). */
  readonly toolsDir: string;
  /** Max LangGraph node visits per agent run before erroring out. */
  readonly recursionLimit: number;
  /** Per-request timeout for Gemini voice (TTS/STT) calls, ms. */
  readonly voiceTimeoutMs: number;
  /** Per-request timeout for Gemini image-generation calls, ms. */
  readonly imageTimeoutMs: number;
  /**
   * Per-tool-invocation deadline applied at lib/tools/index.ts#executeTool.
   * MCP tools have no SDK-level timeout, plugins under JARELA_TOOLS_DIR may
   * hang. The run-registry watchdog is a 15-min backstop, this is the
   * per-call deadline that lets the agent route around stuck tools.
   * Set to 0 to disable (not recommended outside tests). Override with
   * JARELA_TOOL_TIMEOUT_MS.
   */
  readonly toolTimeoutMs: number;
  /**
   * Wall-clock budget for a single agent.stream() invocation. LangGraph's
   * recursionLimit caps step count, not real time — a slow provider or
   * stuck tool can stretch a turn for many minutes. The registry has its
   * own 15-min backstop; this is the tighter per-LLM-stream deadline.
   * Set to 0 to disable. Override with JARELA_LLM_STREAM_MAX_MS.
   */
  readonly llmStreamMaxMs: number;
  /** User-visible app name. Forks override via NEXT_PUBLIC_APP_NAME. */
  readonly appName: string;
  /** Meta description for the HTML <head>. NEXT_PUBLIC_APP_DESCRIPTION. */
  readonly appDescription: string;
  /** "Report a bug" target — GitHub issues URL. NEXT_PUBLIC_APP_ISSUE_URL. */
  readonly issueUrl: string;
}

const DEFAULTS = {
  port: 4312,
  hostname: "127.0.0.1",
  recursionLimit: 200,
  voiceTimeoutMs: 60_000,
  imageTimeoutMs: 60_000,
  // 60s default per tool — generous enough for legitimate slow MCP calls
  // (deep web fetches, LLM-backed sub-tools) but tight enough to keep a
  // wedged tool from soaking minutes.
  toolTimeoutMs: 60_000,
  // 10 min default per LLM stream — long-running react loops with many
  // tools fit; runaway providers don't.
  llmStreamMaxMs: 10 * 60_000,
} as const;

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

let cached: JarelaConfig | null = null;

function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

export function getConfig(): JarelaConfig {
  if (cached) return cached;
  const env = process.env;
  const dataDir = getDataDir();
  cached = {
    port: parsePort(env.JARELA_PORT ?? env.PORT, DEFAULTS.port),
    hostname: (env.JARELA_HOSTNAME ?? env.HOSTNAME ?? DEFAULTS.hostname).trim() || DEFAULTS.hostname,
    dataDir,
    toolsDir: env.JARELA_TOOLS_DIR ? expandHome(env.JARELA_TOOLS_DIR) : join(dataDir, "tools"),
    recursionLimit: parsePositiveInt(env.JARELA_RECURSION_LIMIT, DEFAULTS.recursionLimit),
    voiceTimeoutMs: parsePositiveInt(env.JARELA_VOICE_TIMEOUT_MS, DEFAULTS.voiceTimeoutMs),
    imageTimeoutMs: parsePositiveInt(env.JARELA_IMAGE_TIMEOUT_MS, DEFAULTS.imageTimeoutMs),
    toolTimeoutMs: parseNonNegativeInt(env.JARELA_TOOL_TIMEOUT_MS, DEFAULTS.toolTimeoutMs),
    llmStreamMaxMs: parseNonNegativeInt(env.JARELA_LLM_STREAM_MAX_MS, DEFAULTS.llmStreamMaxMs),
    appName: getAppName(),
    appDescription: getAppDescription(),
    issueUrl: getAppIssueUrl(),
  };
  return cached;
}

/** Test-only: drop the memoised config so the next read picks up env edits. */
export function resetConfigCache(): void {
  cached = null;
}
