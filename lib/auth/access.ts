import { isWhitelisted, touchLastSeen } from "@/lib/stores/access";

// Loopback host header signal — only meaningful when the server is bound to
// 127.0.0.1 (the default). When a reverse proxy fronts Jarela, the proxy is
// expected to preserve the client's original Host header, so this still
// distinguishes "local user typed localhost" from "tailnet client".
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/;
const LOOPBACK_IP = /^(127\.|::1$|::ffff:127\.)/;

export type AccessReason = "loopback" | "whitelisted" | "no-identity" | "not-whitelisted";

export interface AccessResult {
  allowed: boolean;
  identity: string | null;
  reason: AccessReason;
}

interface HeaderBag {
  get(name: string): string | null;
}

interface NodeHeaders {
  [name: string]: string | string[] | undefined;
}

function readHeader(
  headers: HeaderBag | NodeHeaders,
  name: string,
): string | null {
  if (typeof (headers as HeaderBag).get === "function") {
    return (headers as HeaderBag).get(name);
  }
  const lookup = name.toLowerCase();
  const v = (headers as NodeHeaders)[lookup] ?? (headers as NodeHeaders)[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export interface RequireAccessArgs {
  headers: HeaderBag | NodeHeaders;
  host: string | null;
  remoteAddress?: string | null;
}

export function requireAccess({ headers, host, remoteAddress }: RequireAccessArgs): AccessResult {
  // If tailscaled is proxying this request through `tailscale serve` it
  // *always* injects the Tailscale-User-Login header — including for the
  // websocket-sidecar path (`/__jarela_ws__`) which arrives at the node
  // process over loopback. So whenever the header is present, treat the
  // request as a tailnet request and enforce the whitelist, regardless of
  // whether the source IP / Host header looks like loopback. Otherwise a
  // non-whitelisted tailnet user could chat just because the proxy is local.
  const identity = readHeader(headers, "tailscale-user-login")?.trim() || null;
  if (identity) {
    if (isWhitelisted(identity)) {
      touchLastSeen(identity);
      return { allowed: true, identity, reason: "whitelisted" };
    }
    return { allowed: false, identity, reason: "not-whitelisted" };
  }

  // No tailscale identity → only loopback is allowed (the host machine's
  // own user typing http://localhost:4312).

  // 1. WS path: actual TCP source available — most reliable loopback signal.
  if (remoteAddress && LOOPBACK_IP.test(remoteAddress)) {
    return { allowed: true, identity: null, reason: "loopback" };
  }

  // 2. HTTP middleware path: socket source not available, fall back to Host
  //    header. Only trustworthy when the bind is 127.0.0.1 (default).
  if (!remoteAddress && host && LOOPBACK_HOST.test(host)) {
    return { allowed: true, identity: null, reason: "loopback" };
  }

  return { allowed: false, identity: null, reason: "no-identity" };
}

// Convenience wrapper for API route handlers — they only have `Request`.
export function isLoopbackRequest(req: Request): boolean {
  const host = req.headers.get("host");
  return !!host && LOOPBACK_HOST.test(host);
}

// ---------------------------------------------------------------------------
// CSRF / cross-origin / DNS-rebinding defense
// ---------------------------------------------------------------------------
//
// The proxy auth above accepts any loopback request — but every page in the
// user's browser can issue `fetch("http://127.0.0.1:4312/...")`, and a
// remote DNS-rebinding attacker can make `evil.com` resolve to `127.0.0.1`
// so the request looks loopback to the kernel. We need to confirm the
// request *originated* same-origin, not just that the socket terminated on
// loopback.
//
// Defense in depth:
//   1. `Sec-Fetch-Site` — sent by every modern browser. `same-origin` and
//      `none` (top-level nav, address-bar) are safe; `cross-site` and
//      `same-site` are not. Header absent = non-browser caller (curl,
//      installer scripts) — allow, since those can't be tricked into
//      attaching cookies/auth.
//   2. `Origin` — when present, scheme+host+port must match `Host`. Blocks
//      DNS rebinding because the Origin reflects the URL the attacker's
//      page was loaded from (`https://evil.com`), not the resolved IP.
//
// Read-only methods (GET / HEAD / OPTIONS) skip the check: the legitimate
// SSE attach uses GET and is intentionally cross-tab in some PWA flows,
// and these methods shouldn't have side effects anyway.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SAFE_FETCH_SITES = new Set(["same-origin", "none"]);

export type OriginCheckReason =
  | "safe-method"
  | "no-headers"
  | "same-origin"
  | "cross-site"
  | "origin-mismatch";

export interface OriginCheckResult {
  allowed: boolean;
  reason: OriginCheckReason;
}

export interface ValidateRequestOriginArgs {
  method: string;
  headers: HeaderBag | NodeHeaders;
  host: string | null;
}

export function validateRequestOrigin({
  method,
  headers,
  host,
}: ValidateRequestOriginArgs): OriginCheckResult {
  if (SAFE_METHODS.has(method.toUpperCase())) {
    return { allowed: true, reason: "safe-method" };
  }

  const secFetchSite = readHeader(headers, "sec-fetch-site");
  const origin = readHeader(headers, "origin");

  // Neither header → non-browser caller. The loopback bind plus the
  // tailnet identity check already gate this.
  if (!secFetchSite && !origin) {
    return { allowed: true, reason: "no-headers" };
  }

  if (secFetchSite && !SAFE_FETCH_SITES.has(secFetchSite)) {
    return { allowed: false, reason: "cross-site" };
  }

  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        return { allowed: false, reason: "origin-mismatch" };
      }
    } catch {
      // Malformed Origin → reject.
      return { allowed: false, reason: "origin-mismatch" };
    }
  }

  return { allowed: true, reason: "same-origin" };
}
