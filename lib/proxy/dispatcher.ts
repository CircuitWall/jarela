// HTTP proxy dispatcher (ADR-0009).
//
// Routes every undici-backed `fetch` in the server through an HTTP proxy
// when one is configured, so corporate-network installs reach LLM
// providers, MCP servers, and integration APIs.
//
// Two configuration sources, in priority order:
//   1. process.env.HTTP_PROXY / HTTPS_PROXY / NO_PROXY (and their
//      lowercase aliases). Captured at process start so a later DB
//      change cannot accidentally override an explicit env override.
//   2. proxy_config row in SQLite. Read after DB init via
//      applyProxyConfigFromDb(); re-applied from the settings save
//      handler so changes take effect without a server restart.
//
// All paths funnel through `setGlobalDispatcher` so existing call sites
// (providers, tools, MCP, embeddings) inherit the dispatcher at fetch
// time. SDK clients are constructed per-call inside provider methods so
// the next outbound request after a swap picks up the new proxy
// immediately (see ADR-0009 "Live-swap caveats" for the two narrow
// exceptions: in-flight long-lived streams and child-process MCP
// servers).

import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  EnvHttpProxyAgent,
  ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { getProxyConfigRaw, type ProxyConfigRaw } from "@/lib/stores/proxy-config";

const execAsync = promisify(exec);

// Snapshot of HTTP proxy env vars at module load. If the user set them
// before launch (terminal session, plist EnvironmentVariables, …) we
// honor that and ignore the DB config. This preserves the documented
// override path: env > DB.
const ENV_HAD_PROXY_AT_BOOT = !!(
  process.env.HTTP_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.http_proxy ||
  process.env.https_proxy
);

let baselineDispatcher: Dispatcher | null = null;
let envInstalled = false;

// ---------------------------------------------------------------------
// Synchronous boot-time setup
// ---------------------------------------------------------------------
// Runs at module import (before DB init). Installs the env-var-based
// dispatcher synchronously so any keychain / migration path that does
// outbound HTTP from boot can use the proxy. The DB-based layer applies
// later via applyProxyConfigFromDb().
export function ensureProxyDispatcher(): void {
  if (envInstalled) return;
  envInstalled = true;
  // Capture whatever undici initialized as the default so we can revert
  // to it when the user picks `mode = off` and there are no env vars.
  baselineDispatcher = getGlobalDispatcher();
  if (ENV_HAD_PROXY_AT_BOOT) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  }
}

ensureProxyDispatcher();

// ---------------------------------------------------------------------
// Async DB-backed apply
// ---------------------------------------------------------------------

export interface ApplyResult {
  source: "env" | "manual" | "system" | "off";
  proxyUrl: string | null;
  note?: string;
}

// Reads the DB row and reconciles with env vars. Idempotent and safe to
// call after every settings save. Returns a small descriptor that the
// settings save handler can echo back to the UI.
export async function applyProxyConfigFromDb(): Promise<ApplyResult> {
  if (ENV_HAD_PROXY_AT_BOOT) {
    return {
      source: "env",
      proxyUrl: null,
      note: "Honoring HTTPS_PROXY env var; in-app proxy config is ignored while it is set.",
    };
  }

  let cfg: ProxyConfigRaw | null = null;
  try {
    cfg = getProxyConfigRaw();
  } catch (err) {
    // Migration ordering safety net: if proxy_config table doesn't exist
    // yet (older DB about to be migrated), fall back to no-proxy.
    console.warn("[jarela/proxy] could not read proxy_config:", err);
  }

  if (!cfg || cfg.mode === "off") {
    resetToBaseline();
    return { source: "off", proxyUrl: null };
  }

  if (cfg.mode === "manual") {
    if (!cfg.host || !cfg.port) {
      resetToBaseline();
      return { source: "off", proxyUrl: null, note: "manual mode missing host/port; reverted to no proxy" };
    }
    const url = buildProxyUrl(cfg.host, cfg.port, cfg.username, cfg.password);
    installProxy(url, cfg.no_proxy);
    return { source: "manual", proxyUrl: redactAuth(url) };
  }

  if (cfg.mode === "system") {
    const detected = await detectSystemProxy();
    if (!detected) {
      resetToBaseline();
      return {
        source: "off",
        proxyUrl: null,
        note:
          process.platform === "darwin"
            ? "scutil --proxy reported no HTTPS proxy; using direct connection"
            : "system mode is macOS-only in v1; using direct connection",
      };
    }
    const url = buildProxyUrl(detected.host, detected.port, null, null);
    installProxy(url, cfg.no_proxy);
    return { source: "system", proxyUrl: redactAuth(url) };
  }

  resetToBaseline();
  return { source: "off", proxyUrl: null };
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

function buildProxyUrl(host: string, port: number, username: string | null, password: string | null): string {
  const auth = username
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ""}@`
    : "";
  // We default to http:// because corporate proxies overwhelmingly use
  // plaintext HTTP for the proxy hop itself. Users who run an https://
  // proxy can still set the env var by hand (which takes precedence).
  return `http://${auth}${host}:${port}`;
}

function installProxy(url: string, noProxy: string | null): void {
  // Set process.env so EnvHttpProxyAgent honors NO_PROXY semantics
  // (per-host bypass) without us reimplementing the matching logic.
  // We still treat the boot-time env snapshot as authoritative for the
  // "env beats DB" rule — this mutation only happens after we've
  // confirmed the user did NOT set HTTP_PROXY at launch.
  process.env.HTTP_PROXY = url;
  process.env.HTTPS_PROXY = url;
  if (noProxy && noProxy.trim().length > 0) {
    process.env.NO_PROXY = noProxy.trim();
  } else {
    delete process.env.NO_PROXY;
  }
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

function resetToBaseline(): void {
  if (ENV_HAD_PROXY_AT_BOOT) return; // never tear down a user-set env proxy
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.NO_PROXY;
  if (baselineDispatcher) setGlobalDispatcher(baselineDispatcher);
}

function redactAuth(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------
// macOS scutil --proxy parser
// ---------------------------------------------------------------------
// Output is a heredoc-style block of `key : value` lines, one section
// per network service. We only care about the HTTPS bag.

interface DetectedProxy {
  host: string;
  port: number;
}

async function detectSystemProxy(): Promise<DetectedProxy | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execAsync("scutil --proxy", { timeout: 3_000 });
    return parseScutilProxy(stdout);
  } catch (err) {
    console.warn("[jarela/proxy] scutil --proxy failed:", err);
    return null;
  }
}

// Exported for unit-test use. Parses the relevant fields out of
// `scutil --proxy` stdout. Returns null when HTTPSEnable is 0 or the
// host/port pair is missing.
export function parseScutilProxy(output: string): DetectedProxy | null {
  const fields = new Map<string, string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const m = /^([A-Za-z0-9]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    // Only the first occurrence of each key is meaningful — later
    // sections (FTP, SOCKS, …) reuse some names.
    if (!fields.has(m[1])) fields.set(m[1], m[2]);
  }
  if (fields.get("HTTPSEnable") !== "1") return null;
  const host = fields.get("HTTPSProxy");
  const portStr = fields.get("HTTPSPort");
  if (!host || !portStr) return null;
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

// Test-only / diagnostics export: was an env-var proxy set at boot?
export function envProxyWasSetAtBoot(): boolean {
  return ENV_HAD_PROXY_AT_BOOT;
}
