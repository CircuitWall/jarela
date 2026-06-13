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

import { getIntegrationRaw } from "@/lib/stores/integrations";
import { createOAuthFlowStore, type OAuthFlow } from "@/lib/utils/oauth-flow-store";
import { parseJsonSafe } from "@/lib/utils/json";
import { errorMessage } from "@/lib/utils/error";

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

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
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
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

export async function exchangeCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ refresh_token?: string; access_token?: string; expires_in?: number; scope?: string }> {
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const parsed = parseJsonSafe<Record<string, unknown>>(text, {});
  if (!res.ok) {
    const err = (parsed["error_description"] || parsed["error"] || text || `HTTP ${res.status}`) as string;
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
  client_secret: string;
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
  if (saved?.client_id && saved.client_secret && saved.refresh_token) {
    return {
      client_id: saved.client_id,
      client_secret: saved.client_secret,
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
    client_secret: auth.client_secret,
    refresh_token: auth.refresh_token,
    grant_type: "refresh_token",
  });
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
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
