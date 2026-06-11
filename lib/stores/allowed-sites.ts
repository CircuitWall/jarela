// Allowed-sites store. A row represents a host the user has approved the
// agent to use as them. The single approval grants both:
//
//   1. browser-RPC navigation — the extension may drive a tab on this
//      host on the agent's behalf
//   2. cookie passthrough — cookies the extension scrapes for this host
//      (via chrome.cookies.onChanged) get attached to web_fetch requests
//
// The two capabilities live on the same row by design: removing a host
// instantly disables both.
//
// Hostname matching is suffix-based: an allow-list entry for `example.com`
// covers requests to `example.com` and `*.example.com`, but does NOT cover
// `notexample.com`. The matched entry is what cookies are stored under
// and what `last_used_at` updates against.
//
// Cookie blobs are envelope-encrypted (lib/crypto/envelope.ts) — same
// scheme as proxy passwords. The UI never receives cookie values; only
// `has_cookies: boolean` and `cookies_updated_at`.

import { getDb } from "@/lib/db";
import { decrypt, encrypt, isEncrypted } from "@/lib/crypto/envelope";

export interface AllowedSiteStatus {
  hostname: string;
  ssrf_bypass: boolean;
  has_cookies: boolean;
  created_at: string;
  last_used_at: string | null;
  cookies_updated_at: string | null;
}

// Mirror of chrome.cookies.Cookie — only the fields we need to replay a
// cookie as a request header. The browser handles the actual cookie jar
// semantics on the client side; we just relay name/value pairs filtered
// by path/secure/expiry at attach time.
export interface CookieRecord {
  name: string;
  value: string;
  domain: string;            // possibly with a leading dot
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;   // seconds since epoch; absent = session cookie
}

export interface AddAllowedSiteInput {
  hostname: string;
  ssrf_bypass?: boolean;
}

interface Row {
  hostname: string;
  ssrf_bypass: number;
  cookies_blob: string | null;
  created_at: string;
  last_used_at: string | null;
  cookies_updated_at: string | null;
}

const HOSTNAME_RE = /^(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)){3}$/;

const now = (): string => new Date().toISOString();

function normaliseHost(input: string): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().toLowerCase().replace(/\.+$/, "");
  if (!trimmed) return null;
  if (trimmed.length > 253) return null;
  if (HOSTNAME_RE.test(trimmed)) return trimmed;
  if (IPV4_RE.test(trimmed)) return trimmed;
  return null;
}

function rowToStatus(row: Row): AllowedSiteStatus {
  return {
    hostname: row.hostname,
    ssrf_bypass: row.ssrf_bypass === 1,
    has_cookies: row.cookies_blob != null,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    cookies_updated_at: row.cookies_updated_at,
  };
}

export function listAllowedSites(): AllowedSiteStatus[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT hostname, ssrf_bypass, cookies_blob, created_at, last_used_at, cookies_updated_at FROM allowed_sites ORDER BY hostname",
    )
    .all() as unknown as Row[];
  return rows.map(rowToStatus);
}

export function addAllowedSite(
  input: AddAllowedSiteInput,
): AllowedSiteStatus | { error: string } {
  const host = normaliseHost(input.hostname);
  if (!host) return { error: "hostname is not a valid DNS host or IPv4 address" };
  const bypass = input.ssrf_bypass === true ? 1 : 0;
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM allowed_sites WHERE hostname = ?")
    .get(host) as Row | undefined;
  if (existing) {
    if (existing.ssrf_bypass !== bypass) {
      db.prepare("UPDATE allowed_sites SET ssrf_bypass = ? WHERE hostname = ?").run(bypass, host);
      existing.ssrf_bypass = bypass;
    }
    return rowToStatus(existing);
  }
  const created_at = now();
  db.prepare(
    "INSERT INTO allowed_sites (hostname, ssrf_bypass, created_at) VALUES (?, ?, ?)",
  ).run(host, bypass, created_at);
  return {
    hostname: host,
    ssrf_bypass: bypass === 1,
    has_cookies: false,
    created_at,
    last_used_at: null,
    cookies_updated_at: null,
  };
}

export function removeAllowedSite(hostname: string): boolean {
  const host = normaliseHost(hostname);
  if (!host) return false;
  const db = getDb();
  const r = db.prepare("DELETE FROM allowed_sites WHERE hostname = ?").run(host);
  return r.changes > 0;
}

export function setSsrfBypass(hostname: string, bypass: boolean): boolean {
  const host = normaliseHost(hostname);
  if (!host) return false;
  const db = getDb();
  const r = db
    .prepare("UPDATE allowed_sites SET ssrf_bypass = ? WHERE hostname = ?")
    .run(bypass ? 1 : 0, host);
  return r.changes > 0;
}

// Returns the first allow-list entry whose hostname is `host` or a parent
// suffix of `host` (e.g. host=foo.bar.example.com matches an entry of
// `bar.example.com` or `example.com`). Walking from the most specific
// suffix outward means a more-specific allow-list entry wins if both
// happen to be present. Returns null when no entry matches.
function findMatchingEntry(host: string): Row | null {
  const lower = host.toLowerCase();
  const db = getDb();
  // Build the suffix list: foo.bar.example.com, bar.example.com,
  // example.com, com. We could prepare a single OR-clause query, but
  // sqlite's planner handles a small IN list cleanly enough.
  const suffixes: string[] = [];
  let i = 0;
  while (i < lower.length) {
    suffixes.push(lower.slice(i));
    const dot = lower.indexOf(".", i);
    if (dot < 0) break;
    i = dot + 1;
  }
  if (suffixes.length === 0) return null;
  const placeholders = suffixes.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT hostname, ssrf_bypass, cookies_blob, created_at, last_used_at, cookies_updated_at
       FROM allowed_sites WHERE hostname IN (${placeholders})`,
    )
    .all(...suffixes) as unknown as Row[];
  if (rows.length === 0) return null;
  // Prefer the most-specific match (longest hostname).
  rows.sort((a, b) => b.hostname.length - a.hostname.length);
  return rows[0];
}

export interface HostMatch {
  allowed: boolean;
  matchedHostname: string | null;
  ssrfBypass: boolean;
}

export function isHostAllowed(host: string): HostMatch {
  const norm = normaliseHost(host);
  if (!norm) return { allowed: false, matchedHostname: null, ssrfBypass: false };
  const row = findMatchingEntry(norm);
  if (!row) return { allowed: false, matchedHostname: null, ssrfBypass: false };
  return {
    allowed: true,
    matchedHostname: row.hostname,
    ssrfBypass: row.ssrf_bypass === 1,
  };
}

// Stores cookies for an allow-listed host. Returns false (no write) if
// the host is not on the allow-list — the API route translates this to
// 403. The blob is the raw JSON of the cookie array, encrypted as a
// single string. We do NOT pre-flatten to a Cookie header at write time
// because per-request filtering (path, secure, expiry) needs the
// structured form.
export function putCookies(hostname: string, cookies: CookieRecord[]): boolean {
  const host = normaliseHost(hostname);
  if (!host) return false;
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM allowed_sites WHERE hostname = ?").get(host);
  if (!exists) return false;
  const blob = encrypt(JSON.stringify(cookies));
  db.prepare(
    "UPDATE allowed_sites SET cookies_blob = ?, cookies_updated_at = ? WHERE hostname = ?",
  ).run(blob, now(), host);
  return true;
}

// Server-only. Resolves the URL's host against the allow-list, filters the
// stored cookies for the URL's path/secure/expiry, and returns the joined
// "name=value; …" string. Bumps last_used_at as a side effect so the UI
// can show when a host was last consulted. Returns null when no allow-list
// match, no stored cookies, or no cookies pass the filter.
export function getCookieHeaderForUrl(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const match = isHostAllowed(parsed.hostname);
  if (!match.allowed || !match.matchedHostname) return null;

  const db = getDb();
  const row = db
    .prepare("SELECT cookies_blob FROM allowed_sites WHERE hostname = ?")
    .get(match.matchedHostname) as { cookies_blob: string | null } | undefined;
  if (!row || !row.cookies_blob) return null;

  let cookies: CookieRecord[];
  try {
    const decoded = isEncrypted(row.cookies_blob) ? decrypt(row.cookies_blob) : row.cookies_blob;
    cookies = JSON.parse(decoded) as CookieRecord[];
  } catch {
    return null;
  }

  const isHttps = parsed.protocol === "https:";
  const reqHost = parsed.hostname.toLowerCase();
  const reqPath = parsed.pathname || "/";
  const nowSec = Math.floor(Date.now() / 1000);

  const out: string[] = [];
  for (const c of cookies) {
    if (!c || typeof c.name !== "string" || typeof c.value !== "string") continue;
    if (c.secure && !isHttps) continue;
    if (typeof c.expirationDate === "number" && c.expirationDate < nowSec) continue;
    if (!cookieDomainMatches(reqHost, c.domain ?? match.matchedHostname)) continue;
    if (!cookiePathMatches(reqPath, c.path ?? "/")) continue;
    out.push(`${c.name}=${c.value}`);
  }
  if (out.length === 0) return null;

  db.prepare("UPDATE allowed_sites SET last_used_at = ? WHERE hostname = ?")
    .run(now(), match.matchedHostname);

  return out.join("; ");
}

// RFC 6265 §5.1.3 domain matching. A cookie with domain "example.com"
// matches request host "example.com" and "*.example.com". A leading dot
// on the cookie's domain is legacy syntax and means the same thing.
function cookieDomainMatches(reqHost: string, cookieDomain: string): boolean {
  const cd = cookieDomain.replace(/^\./, "").toLowerCase();
  if (!cd) return false;
  if (reqHost === cd) return true;
  return reqHost.endsWith("." + cd);
}

// RFC 6265 §5.1.4. Cookie path "/" matches everything. Otherwise the
// request path must equal the cookie path or have it as a directory
// prefix (e.g. cookie path "/admin" matches "/admin", "/admin/users",
// but not "/administrator").
function cookiePathMatches(reqPath: string, cookiePath: string): boolean {
  if (cookiePath === "/" || !cookiePath) return true;
  if (reqPath === cookiePath) return true;
  if (reqPath.startsWith(cookiePath + "/")) return true;
  if (cookiePath.endsWith("/") && reqPath.startsWith(cookiePath)) return true;
  return false;
}
