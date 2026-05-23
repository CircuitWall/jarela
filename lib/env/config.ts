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
  };
  return cached;
}

/** Test-only: drop the memoised config so the next read picks up env edits. */
export function resetConfigCache(): void {
  cached = null;
}
