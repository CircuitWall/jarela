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

  // agent
  readonly recursionLimit: number;
  /** Per-request timeout for Gemini voice (TTS/STT) calls, ms. */
  readonly voiceTimeoutMs: number;
  /** Per-request timeout for Gemini image-generation calls, ms. */
  readonly imageTimeoutMs: number;
  /** User-visible app name. Forks override via NEXT_PUBLIC_APP_NAME. */
  readonly appName: string;
  readonly appDescription: string;
  readonly issueUrl: string;
}

const DEFAULTS = {
  port: 4312,
  hostname: "127.0.0.1",
  recursionLimit: 200,
  voiceTimeoutMs: 60_000,
  imageTimeoutMs: 60_000,
} as const;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
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
    recursionLimit: parsePositiveInt(env.JARELA_RECURSION_LIMIT, DEFAULTS.recursionLimit),
    voiceTimeoutMs: parsePositiveInt(env.JARELA_VOICE_TIMEOUT_MS, DEFAULTS.voiceTimeoutMs),
    imageTimeoutMs: parsePositiveInt(env.JARELA_IMAGE_TIMEOUT_MS, DEFAULTS.imageTimeoutMs),
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
