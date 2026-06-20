// Ephemeral state store for the in-app Gmail OAuth flow.
//
// The user types client_id + client_secret in the Integrations panel and clicks
// "Connect Gmail". We POST those to /oauth/start, which stashes them here keyed
// by a random `state` token and returns the Google authorize URL. The browser
// opens that URL; Google bounces back to /oauth/callback with `?code&state`,
// which exchanges the code for a refresh_token and persists the integration.
// Meanwhile the panel polls /oauth/status to know when to refresh.
//
// Pinned to globalThis so HMR in dev doesn't lose pending flows.

import { createHash, randomBytes } from "node:crypto";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { createOAuthFlowStore, type OAuthFlow } from "@/lib/utils/oauth-flow-store";
import { parseJsonSafe } from "@/lib/utils/json";
import { errorMessage } from "@/lib/utils/error";
import { sanitizeOAuthInput, secretFingerprint } from "@/lib/utils/oauth-input";

export type { OAuthFlow };

const flowStore = createOAuthFlowStore({ globalKey: "__ggOauthFlows" });

export const createFlow = flowStore.create;
export const getFlow = flowStore.get;
export const updateFlow = flowStore.update;

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  // Calendar: read/write events on the user's existing calendars. Narrow
  // scope on purpose — doesn't grant create/delete of entire calendars
  // (matches the principle-of-least-privilege the Gmail scopes follow).
  "https://www.googleapis.com/auth/calendar.events",
  // Read-only metadata of the user's calendar list. Required for the
  // calendarList.list endpoint that powers calendarListCalendarsTool —
  // calendar.events alone returns 403 there.
  "https://www.googleapis.com/auth/calendar.readonly",
];

// ---------------------------------------------------------------------------
// Bundled Jarela-owned OAuth client (Desktop type)
// ---------------------------------------------------------------------------
//
// Google's `oauth2.googleapis.com/token` endpoint requires `client_secret` on
// every code-exchange and refresh call, even for Desktop clients using PKCE.
// (Google's "Optional" wording in the OAuth-for-native-apps doc reflects the
// RFC spec, not the production endpoint's actual behaviour.) Shipping the
// secret in this repo would attract CVSS-7.5 reports the moment the source
// hits GitHub, so we keep it server-side: requests for the bundled client_id
// are routed through a Cloud Run Function (see `/proxy/`) that injects the
// secret from Secret Manager before forwarding to Google.
//
// Forks/self-hosters override the bundled client_id via JARELA_GMAIL_CLIENT_ID
// and the proxy URL via JARELA_GOOGLE_TOKEN_PROXY. The legacy BYO Advanced
// fields still accept a full client_id + client_secret pair for users who'd
// rather use their own GCP project (bypasses the proxy entirely).
const DEFAULT_DESKTOP_CLIENT_ID =
  process.env.JARELA_GMAIL_CLIENT_ID?.trim() ||
  "134669812881-for5e5bjirjt9s2f53cvc3lcj5q257c7.apps.googleusercontent.com";

export interface DefaultGoogleClient {
  client_id: string;
  // client_secret intentionally absent: the proxy injects it server-side from
  // Secret Manager. Nothing in this repo references the secret value.
}

export function getDefaultGoogleClient(): DefaultGoogleClient {
  return { client_id: DEFAULT_DESKTOP_CLIENT_ID };
}

// True when the resolved client_id is the bundled Jarela one (NOT a BYO
// from env or the Advanced credentials panel). Used by the callback to
// avoid persisting a redundant client_id row — `resolveGoogleAuth` reads
// it back from the bundle on demand instead.
export function isDefaultGoogleClient(id: string): boolean {
  return id === getDefaultGoogleClient().client_id;
}

// ---------------------------------------------------------------------------
// Token endpoint resolution: bundled-client traffic goes through Jarela's
// hosted proxy which injects `client_secret` from Secret Manager. BYO traffic
// goes direct to Google — the user supplied their own secret and the proxy
// neither has nor wants it. Self-hosters override the proxy URL via
// JARELA_GOOGLE_TOKEN_PROXY.
// ---------------------------------------------------------------------------

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const JARELA_TOKEN_PROXY =
  process.env.JARELA_GOOGLE_TOKEN_PROXY?.trim() ||
  "https://jarela-oauth-proxy-134669812881.europe-west1.run.app";

function selectTokenEndpoint(clientId: string, hasClientSecret: boolean): string {
  if (isDefaultGoogleClient(clientId) && !hasClientSecret) return JARELA_TOKEN_PROXY;
  return GOOGLE_TOKEN_ENDPOINT;
}

// Public re-export for callers that need to mirror the routing decision
// without going through `getGoogleAccessToken` (e.g. the Gmail health
// probe, which needs precise HTTP-status-aware error mapping).
export const resolveGoogleTokenEndpoint = selectTokenEndpoint;

// PKCE per RFC 7636. With no client_secret in play, the per-flow
// code_verifier is the only thing tying the redeemed authorization code
// to this specific Jarela process.
export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  // 32 random bytes → 43-char base64url string (well within the 43-128 spec).
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const p = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

export async function exchangeCode(opts: {
  code: string;
  clientId: string;
  // Optional. Bundled-client traffic omits this and routes through the proxy
  // which adds the secret server-side. BYO users with their own GCP project
  // pass their own secret and go direct to Google.
  clientSecret?: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ refresh_token?: string; access_token?: string; expires_in?: number; scope?: string }> {
  const clientId = sanitizeOAuthInput(opts.clientId) ?? "";
  const clientSecret = opts.clientSecret ? (sanitizeOAuthInput(opts.clientSecret) ?? "") : "";
  const body = new URLSearchParams({
    code: opts.code,
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
    code_verifier: opts.codeVerifier,
  });
  if (clientSecret) body.set("client_secret", clientSecret);
  const endpoint = selectTokenEndpoint(clientId, Boolean(clientSecret));
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const parsed = parseJsonSafe<Record<string, unknown>>(text, {});
  if (!res.ok) {
    const err = (parsed["error_description"] || parsed["error"] || text || `HTTP ${res.status}`) as string;
    console.error(
      `[gmail-oauth] token exchange rejected (${res.status}): ${err} | client_id ${secretFingerprint(clientId)} | client_secret ${secretFingerprint(clientSecret)}`,
    );
    throw new Error(err);
  }
  return parsed as { refresh_token?: string; access_token?: string; expires_in?: number; scope?: string };
}

// ---------------------------------------------------------------------------
// Shared Google API auth (Gmail + Calendar + any future Google scope)
// ---------------------------------------------------------------------------
//
// The same OAuth client (stored under integration name "gmail" for back-compat)
// grants every Google scope we ask for. Tools across `lib/tools/` share these
// helpers so a burst of mixed Gmail+Calendar calls hits Google's token
// endpoint once per refresh, not once per file.

export interface GoogleAuth {
  client_id: string;
  // Optional: undefined when using the bundled client (proxy supplies secret).
  client_secret?: string;
  refresh_token: string;
}

export function resolveGoogleAuth(): GoogleAuth | { error: string } {
  const envId = process.env.GMAIL_CLIENT_ID;
  const envSecret = process.env.GMAIL_CLIENT_SECRET;
  const envRefresh = process.env.GMAIL_REFRESH_TOKEN;
  if (envId && envSecret && envRefresh) {
    return { client_id: envId, client_secret: envSecret, refresh_token: envRefresh };
  }
  const saved = getIntegrationRaw("gmail");
  if (saved?.refresh_token) {
    // Stored client_id wins when present (BYO path); otherwise fall back to
    // the bundled Jarela client_id. client_secret is only set on the BYO
    // path — the bundled client's secret is injected server-side by the proxy.
    if (saved.client_id && saved.client_secret) {
      return {
        client_id: saved.client_id,
        client_secret: saved.client_secret,
        refresh_token: saved.refresh_token,
      };
    }
    return {
      client_id: saved.client_id || getDefaultGoogleClient().client_id,
      refresh_token: saved.refresh_token,
    };
  }
  return {
    error:
      "Google account not connected. Open the gear menu → Integrations tab → " +
      "Gmail card and click Connect Gmail to authorize Gmail + Calendar access.",
  };
}

interface CachedAccessToken { token: string; expires_at: number }
const accessTokenCache = new Map<string, CachedAccessToken>();

export async function getGoogleAccessToken(
  auth: GoogleAuth,
): Promise<string | { error: string }> {
  const key = auth.refresh_token.slice(0, 20);
  const cached = accessTokenCache.get(key);
  if (cached && cached.expires_at > Date.now() + 60_000) return cached.token;

  const body = new URLSearchParams({
    client_id: auth.client_id,
    refresh_token: auth.refresh_token,
    grant_type: "refresh_token",
  });
  if (auth.client_secret) body.set("client_secret", auth.client_secret);
  const endpoint = selectTokenEndpoint(auth.client_id, Boolean(auth.client_secret));
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      // Drop any stale cached token so a reconnected (broader-scope) refresh
      // re-exchanges cleanly on the next call.
      accessTokenCache.delete(key);
      return { error: `OAuth token refresh failed (${res.status}): ${text.slice(0, 300)}` };
    }
    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) return { error: "OAuth response missing access_token" };
    const expires_at = Date.now() + (parsed.expires_in ?? 3000) * 1000;
    accessTokenCache.set(key, { token: parsed.access_token, expires_at });
    return parsed.access_token;
  } catch (err) {
    return { error: `OAuth token refresh threw: ${errorMessage(err)}` };
  }
}

/**
 * Shared bearer-auth fetch for Google REST APIs (Gmail, Calendar, ...).
 *
 * Behaviour:
 *   - Resolves access token from `auth`; if that fails, the error object is
 *     surfaced unchanged so callers can pass it back to the agent.
 *   - 204 No Content → `{ ok: true }` (used by DELETE endpoints).
 *   - Non-2xx response → `{ error: "<service> <status>: <body slice>", url }`.
 *   - 2xx with body → parsed JSON if possible, raw text otherwise.
 *   - Fetch throws (DNS, abort, timeout) → `{ error: "<service> fetch threw: ..." }`.
 *
 * @param service Short tag used in error messages, e.g. "Gmail" or "Calendar".
 * @param baseUrl Base for relative `path` (e.g. `https://gmail.googleapis.com/gmail/v1/users/me`).
 * @param path Either a full URL (starts with `http`) or path appended to baseUrl.
 */
export async function googleFetch(
  auth: GoogleAuth,
  service: string,
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const token = await getGoogleAccessToken(auth);
  if (typeof token !== "string") return token;
  const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 204) return { ok: true };
    const text = await res.text();
    if (!res.ok) {
      return { error: `${service} ${res.status}: ${text.slice(0, 500)}`, url };
    }
    try { return JSON.parse(text); } catch { return text; }
  } catch (err) {
    return { error: `${service} fetch threw: ${errorMessage(err)}` };
  }
}
