// Proxy configuration store (ADR-0009, extended ADR-0012).
//
// Single-row table proxy_config. Non-secret columns are plaintext for
// diagnostics; only `password` is wrapped through lib/crypto/envelope.ts
// so the on-disk DB cannot reveal the proxy credential. `ca_bundle` is
// a PEM (public cert) so it stays plaintext as well.
//
// Two read shapes:
//   - getProxyConfigStatus(): UI shape — password masked as SECRET_MASK
//   - getProxyConfigRaw():    server-only — returns the real password
//                             so lib/proxy/dispatcher.ts can build a
//                             ProxyAgent
//
// The save handler accepts SECRET_MASK as the sentinel for "keep
// existing password" so the UI can echo back the masked form without
// blanking the secret.

import { getDb } from "@/lib/db";
import { decryptIfNeeded, encrypt } from "@/lib/crypto/envelope";
import { SECRET_MASK } from "@/lib/stores/integrations";

export type ProxyMode = "off" | "manual" | "system";
export type ProxyScheme = "http" | "https";

export interface ProxyConfigStatus {
  mode: ProxyMode;
  scheme: ProxyScheme;
  host: string | null;
  port: number | null;
  username: string | null;
  password: string | null; // SECRET_MASK when set, null when unset
  no_proxy: string | null;
  ca_bundle: string | null; // PEM, plaintext
  updated_at: string | null;
}

export interface ProxyConfigRaw {
  mode: ProxyMode;
  scheme: ProxyScheme;
  host: string | null;
  port: number | null;
  username: string | null;
  password: string | null; // plaintext
  no_proxy: string | null;
  ca_bundle: string | null;
  updated_at: string;
}

export interface ProxyConfigInput {
  mode: ProxyMode;
  scheme?: ProxyScheme;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  no_proxy?: string | null;
  ca_bundle?: string | null;
}

interface Row {
  mode: string;
  scheme: string | null;
  host: string | null;
  port: number | null;
  username: string | null;
  password: string | null;
  no_proxy: string | null;
  ca_bundle: string | null;
  updated_at: string;
}

const DEFAULT_STATUS: ProxyConfigStatus = {
  mode: "off",
  scheme: "http",
  host: null,
  port: null,
  username: null,
  password: null,
  no_proxy: null,
  ca_bundle: null,
  updated_at: null,
};

export function getProxyConfigStatus(): ProxyConfigStatus {
  const row = readRow();
  if (!row) return DEFAULT_STATUS;
  return {
    mode: normaliseMode(row.mode),
    scheme: normaliseScheme(row.scheme),
    host: row.host,
    port: row.port,
    username: row.username,
    password: row.password ? SECRET_MASK : null,
    no_proxy: row.no_proxy,
    ca_bundle: row.ca_bundle,
    updated_at: row.updated_at,
  };
}

// Server-only. Decrypts the password envelope. Never expose this to the
// API surface — the dispatcher and any future test endpoint are the only
// legitimate callers.
export function getProxyConfigRaw(): ProxyConfigRaw | null {
  const row = readRow();
  if (!row) return null;
  return {
    mode: normaliseMode(row.mode),
    scheme: normaliseScheme(row.scheme),
    host: row.host,
    port: row.port,
    username: row.username,
    password: row.password ? decryptIfNeeded(row.password) : null,
    no_proxy: row.no_proxy,
    ca_bundle: row.ca_bundle,
    updated_at: row.updated_at,
  };
}

export function saveProxyConfig(input: ProxyConfigInput): ProxyConfigStatus | { error: string } {
  if (!isValidMode(input.mode)) return { error: `invalid mode "${input.mode}"` };

  const scheme: ProxyScheme = input.scheme === "https" ? "https" : "http";

  // Manual mode requires host + port. system / off don't.
  if (input.mode === "manual") {
    if (!input.host || !input.host.trim()) return { error: "host is required in manual mode" };
    if (input.port == null || !Number.isFinite(input.port) || input.port <= 0 || input.port > 65535) {
      return { error: "port must be between 1 and 65535" };
    }
  }

  // CA bundle: empty/null clears; non-empty must look like PEM.
  let storedCaBundle: string | null = null;
  if (input.ca_bundle != null && input.ca_bundle.trim().length > 0) {
    if (!input.ca_bundle.includes("-----BEGIN CERTIFICATE-----")) {
      return { error: "ca_bundle must be PEM (no BEGIN CERTIFICATE block found)" };
    }
    storedCaBundle = input.ca_bundle;
  }

  // Preserve existing password when the UI echoes back the masked sentinel.
  const existing = readRow();
  let storedPassword: string | null = null;
  if (input.password === SECRET_MASK) {
    storedPassword = existing?.password ?? null;
  } else if (input.password && input.password.length > 0) {
    storedPassword = encrypt(input.password);
  } else {
    storedPassword = null;
  }

  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO proxy_config (id, mode, scheme, host, port, username, password, no_proxy, ca_bundle, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mode = excluded.mode,
       scheme = excluded.scheme,
       host = excluded.host,
       port = excluded.port,
       username = excluded.username,
       password = excluded.password,
       no_proxy = excluded.no_proxy,
       ca_bundle = excluded.ca_bundle,
       updated_at = excluded.updated_at`,
  ).run(
    input.mode,
    scheme,
    nullable(input.host),
    input.port ?? null,
    nullable(input.username),
    storedPassword,
    nullable(input.no_proxy),
    storedCaBundle,
    now,
  );

  return getProxyConfigStatus();
}

export function deleteProxyConfig(): boolean {
  const db = getDb();
  const r = db.prepare("DELETE FROM proxy_config WHERE id = 1").run();
  return r.changes > 0;
}

function readRow(): Row | null {
  const db = getDb();
  const r = db
    .prepare(
      "SELECT mode, scheme, host, port, username, password, no_proxy, ca_bundle, updated_at FROM proxy_config WHERE id = 1",
    )
    .get() as Row | undefined;
  return r ?? null;
}

function isValidMode(m: string): m is ProxyMode {
  return m === "off" || m === "manual" || m === "system";
}

function normaliseMode(m: string): ProxyMode {
  return isValidMode(m) ? m : "off";
}

function normaliseScheme(s: string | null | undefined): ProxyScheme {
  return s === "https" ? "https" : "http";
}

function nullable(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}
