// Ephemeral state store + shared auth helpers for the in-app Microsoft OAuth
// flow. Mirrors lib/integrations/gmail-oauth.ts but targets the Microsoft
// identity platform (v2.0 endpoint, common tenant by default) and Microsoft
// Graph as the downstream API surface (Outlook Mail + Calendar in v1).
//
// The user types client_id + client_secret in the Integrations panel and
// clicks "Connect Outlook". We POST those to /oauth/start, which stashes
// them here keyed by a random `state` token and returns the Microsoft
// authorize URL. The browser opens that URL; MS bounces back to
// /oauth/callback with `?code&state`, which exchanges the code for a
// refresh_token (granted because we asked for `offline_access`) and
// persists the integration. The panel polls /oauth/status separately.
//
// Pinned to globalThis so HMR in dev doesn't lose pending flows.

import { getIntegrationRaw } from "@/lib/stores/integrations";
import { createOAuthFlowStore, type OAuthFlow } from "@/lib/utils/oauth-flow-store";
import { parseJsonSafe } from "@/lib/utils/json";
import { errorMessage } from "@/lib/utils/error";
import { sanitizeOAuthInput, secretFingerprint } from "@/lib/utils/oauth-input";

export type { OAuthFlow };

const flowStore = createOAuthFlowStore({ globalKey: "__msOauthFlows" });

export const createFlow = flowStore.create;
export const getFlow = flowStore.get;
export const updateFlow = flowStore.update;

// Tenant selector. `common` accepts both personal Microsoft accounts
// (@outlook.com, @hotmail.com, @live.com) and work/school M365 accounts.
// Switch to `consumers` to lock to personal only, or `organizations` for
// work/school only. We expose this as an env override for power users but
// don't surface it in the UI yet.
const TENANT = process.env.OUTLOOK_TENANT?.trim() || "common";

// Delegated Graph scopes the agent needs. Keep narrow:
//   - offline_access  → required for a refresh_token (MS counterpart of
//                       Google's access_type=offline).
//   - User.Read       → used by the test endpoint to call /me.
//   - Mail.ReadWrite  → search/read mail, create drafts, mark read,
//                       move to folders (incl. DeletedItems). Does NOT
//                       grant sending — matches our Gmail "drafts only"
//                       stance via gmail.compose.
//   - Calendars.ReadWrite → list/get/create/update/delete events on the
//                           user's existing calendars.
//   - Tasks.ReadWrite → list/get/create/update/complete/delete Microsoft
//                       To Do tasks and lists (ms_todo_* tools).
//   - People.Read     → resolve "who is X" / frequent contacts via
//                       /me/people (ms_people_resolve tool).
export const MICROSOFT_SCOPES = [
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Calendars.ReadWrite",
  "Tasks.ReadWrite",
  "People.Read",
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
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    // Force consent so a returning user actually re-grants any newly-added
    // scope (otherwise MS silently reuses the prior grant minus the new bit).
    prompt: "consent",
    state: opts.state,
  });
  return `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?${p.toString()}`;
}

// NOTE: Unlike Google, MS v2 endpoint **requires** the `scope` parameter on
// every grant_type call (both authorization_code and refresh_token). Leaving
// it out yields `AADSTS900144: The request body must contain the following
// parameter: 'scope'.`. We always pass the full scope set.
export async function exchangeCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ refresh_token?: string; access_token?: string; expires_in?: number; scope?: string }> {
  const clientId = sanitizeOAuthInput(opts.clientId) ?? "";
  const clientSecret = sanitizeOAuthInput(opts.clientSecret) ?? "";
  const body = new URLSearchParams({
    code: opts.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
    scope: MICROSOFT_SCOPES.join(" "),
  });
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
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
      `[microsoft-oauth] token exchange rejected (${res.status}): ${err} | client_id ${secretFingerprint(clientId)} | client_secret ${secretFingerprint(clientSecret)}`,
    );
    throw new Error(err);
  }
  return parsed as { refresh_token?: string; access_token?: string; expires_in?: number; scope?: string };
}

// ---------------------------------------------------------------------------
// Shared Microsoft Graph auth (Outlook Mail + Calendar + future Graph scopes)
// ---------------------------------------------------------------------------

export interface MicrosoftAuth {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

export function resolveMicrosoftAuth(): MicrosoftAuth | { error: string } {
  const envId = process.env.OUTLOOK_CLIENT_ID;
  const envSecret = process.env.OUTLOOK_CLIENT_SECRET;
  const envRefresh = process.env.OUTLOOK_REFRESH_TOKEN;
  if (envId && envSecret && envRefresh) {
    return { client_id: envId, client_secret: envSecret, refresh_token: envRefresh };
  }
  const saved = getIntegrationRaw("outlook");
  if (saved?.client_id && saved.client_secret && saved.refresh_token) {
    return {
      client_id: saved.client_id,
      client_secret: saved.client_secret,
      refresh_token: saved.refresh_token,
    };
  }
  return {
    error:
      "Microsoft account not connected. Open the gear menu → Integrations tab → " +
      "Outlook card and click Connect Outlook to authorize Mail + Calendar access.",
  };
}

interface CachedAccessToken { token: string; expires_at: number }
const accessTokenCache = new Map<string, CachedAccessToken>();

function cacheKey(auth: MicrosoftAuth): string {
  return auth.refresh_token.slice(0, 20);
}

// Force-evict a cached access token (e.g. after a 401). The next call to
// getMicrosoftAccessToken will refresh against the v2 token endpoint.
function bustAccessToken(auth: MicrosoftAuth): void {
  accessTokenCache.delete(cacheKey(auth));
}

export async function getMicrosoftAccessToken(
  auth: MicrosoftAuth,
): Promise<string | { error: string }> {
  const key = cacheKey(auth);
  const cached = accessTokenCache.get(key);
  if (cached && cached.expires_at > Date.now() + 60_000) return cached.token;

  const body = new URLSearchParams({
    client_id: auth.client_id,
    client_secret: auth.client_secret,
    refresh_token: auth.refresh_token,
    grant_type: "refresh_token",
    // Required on the v2 endpoint even for refresh_token grants.
    scope: MICROSOFT_SCOPES.join(" "),
  });
  try {
    const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      accessTokenCache.delete(key);
      return { error: `Microsoft OAuth refresh failed (${res.status}): ${text.slice(0, 300)}` };
    }
    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) return { error: "OAuth response missing access_token" };
    const expires_at = Date.now() + (parsed.expires_in ?? 3000) * 1000;
    accessTokenCache.set(key, { token: parsed.access_token, expires_at });
    return parsed.access_token;
  } catch (err) {
    return { error: `Microsoft OAuth refresh threw: ${errorMessage(err)}` };
  }
}

// Path-prefix → required Graph scope. Used to render helpful 403 messages
// pointing the user at the exact scope they need to reconnect with.
const SCOPE_HINTS: Array<{ prefix: string; scope: string }> = [
  { prefix: "/me/messages", scope: "Mail.ReadWrite" },
  { prefix: "/me/mailFolders", scope: "Mail.ReadWrite" },
  { prefix: "/me/sendMail", scope: "Mail.Send" },
  { prefix: "/me/events", scope: "Calendars.ReadWrite" },
  { prefix: "/me/calendar", scope: "Calendars.ReadWrite" },
  { prefix: "/me/calendars", scope: "Calendars.ReadWrite" },
  { prefix: "/me/todo", scope: "Tasks.ReadWrite" },
  { prefix: "/me/people", scope: "People.Read" },
  { prefix: "/me/contacts", scope: "Contacts.Read" },
  { prefix: "/me/drive", scope: "Files.Read" },
  { prefix: "/me/insights", scope: "Sites.Read.All" },
  { prefix: "/search/query", scope: "Mail.Read Files.Read.All" },
  { prefix: "/me", scope: "User.Read" },
];

function scopeHintFor(path: string): string | null {
  const p = path.startsWith("http") ? new URL(path).pathname.replace(/^\/v1\.0/, "") : path;
  for (const { prefix, scope } of SCOPE_HINTS) {
    if (p.startsWith(prefix)) return scope;
  }
  return null;
}

function parseRetryAfter(headerVal: string | null): number {
  if (!headerVal) return 0;
  const secs = Number.parseInt(headerVal, 10);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, 30) * 1000;
  const ts = Date.parse(headerVal);
  if (!Number.isNaN(ts)) return Math.max(0, Math.min(ts - Date.now(), 30_000));
  return 0;
}

function backoffFor(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 4000);
}

// Shared Graph fetch helper. Used by lib/tools/outlook.ts,
// lib/tools/outlook-calendar.ts, lib/tools/ms-todo.ts, lib/tools/ms-graph.ts.
// Returns parsed JSON or { error: string, url? }. 204 No Content returns
// { ok: true }.
//
// Built-in resilience:
//   - 401 Unauthorized → drop the cached access token and retry once with a
//     freshly refreshed one (covers token-revoked-mid-cache edge cases).
//   - 429 / 503 → honour the `Retry-After` header (capped at 30s) or fall
//     back to exponential backoff. Retries up to 3 times.
//   - 403 Forbidden → surface a scope hint ("reconnect with X") so the
//     operator knows what to grant.
export async function graphFetch(
  auth: MicrosoftAuth,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const url = path.startsWith("http") ? path : `https://graph.microsoft.com/v1.0${path}`;
  let attempt = 0;
  let triedReauth = false;

  while (true) {
    const token = await getMicrosoftAccessToken(auth);
    if (typeof token !== "string") return token;

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return { error: `Graph fetch threw: ${errorMessage(err)}`, url };
    }

    if (res.status === 204) return { ok: true };

    if (res.status === 401 && !triedReauth) {
      triedReauth = true;
      bustAccessToken(auth);
      continue;
    }

    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      const waitMs = parseRetryAfter(res.headers.get("Retry-After")) ?? backoffFor(attempt);
      attempt += 1;
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    const text = await res.text();
    if (!res.ok) {
      let msg = `Graph ${res.status}: ${text.slice(0, 500)}`;
      if (res.status === 403) {
        const hint = scopeHintFor(path);
        if (hint) {
          msg += ` — reconnect the Microsoft integration with scope: ${hint}`;
        }
      }
      return { error: msg, url };
    }
    try { return JSON.parse(text); } catch { return text; }
  }
}

// Follow @odata.nextLink across pages and concatenate `value` arrays.
// Stops at `maxPages` (default 5) to bound context cost. Returns the same
// shape as graphFetch (object with `.value`) but with the merged array, or
// the original error shape if any page errored.
export async function graphPaged(
  auth: MicrosoftAuth,
  path: string,
  opts?: { maxPages?: number; init?: RequestInit },
): Promise<unknown> {
  const maxPages = opts?.maxPages ?? 5;
  let current: string | null = path;
  const merged: unknown[] = [];
  let pages = 0;

  while (current && pages < maxPages) {
    const page = await graphFetch(auth, current, opts?.init);
    if (page && typeof page === "object" && "error" in page) return page;
    const body = page as { value?: unknown[]; "@odata.nextLink"?: string };
    if (Array.isArray(body.value)) merged.push(...body.value);
    current = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : null;
    pages += 1;
  }
  return { value: merged, pages };
}
