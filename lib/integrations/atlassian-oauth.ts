// Ephemeral state store + shared auth helpers for the in-app Atlassian OAuth
// flow, mirroring lib/integrations/gmail-oauth.ts and
// lib/integrations/microsoft-oauth.ts.
//
// The user types client_id + client_secret in the Integrations panel and
// clicks "Connect Atlassian". We POST those to /oauth/start, which stashes
// them here keyed by a random `state` token and returns the Atlassian
// authorize URL. The browser bounces back to /oauth/callback with
// `?code&state`, which exchanges the code for tokens and persists the
// integration. The panel polls /oauth/status separately.
//
// Pinned to globalThis so HMR in dev doesn't lose pending flows.

import { getIntegrationRaw } from "@/lib/stores/integrations";
import { createOAuthFlowStore, type OAuthFlow } from "@/lib/utils/oauth-flow-store";
import { parseJsonSafe } from "@/lib/utils/json";
import { errorMessage } from "@/lib/utils/error";
import { sanitizeOAuthInput, secretFingerprint } from "@/lib/utils/oauth-input";

export type { OAuthFlow };

const flowStore = createOAuthFlowStore({ globalKey: "__atlassianOauthFlows" });

export const createFlow = flowStore.create;
export const getFlow = flowStore.get;
export const updateFlow = flowStore.update;

// Atlassian API scopes the agent needs. These grant read + write access to
// Jira issues/projects/sprints, Confluence content/spaces/comments, and
// account/profile info. offline_access yields a refresh_token for long-lived
// sessions without re-authorization.
export const ATLASSIAN_SCOPES = [
  "manage:jira-project",
  "manage:jira-configuration",
  "offline_access",
  "read:account",
  "read:board-scope.admin:jira-software",
  "read:board-scope:jira-software",
  "read:project:jira",
  "read:comment:confluence",
  "read:confluence-content.all",
  "read:confluence-content.summary",
  "read:confluence-props",
  "read:confluence-space",
  "read:confluence-space.summary",
  "read:confluence-user",
  "read:content-details:confluence",
  "read:content:confluence",
  "read:issue-details:jira",
  "read:issue-meta:jira",
  "read:jql:jira",
  "read:page:confluence",
  "read:space:confluence",
  "read:jira-user",
  "read:jira-work",
  "read:me",
  "read:sprint:jira-software",
  "search:confluence",
  "write:comment:confluence",
  "write:confluence-content",
  "write:confluence-space",
  "write:page:confluence",
  "write:attachment:confluence",
  "write:confluence-file",
  "write:jira-work",
  "write:sprint:jira-software",
];

// Whether the provider is Jira or Confluence determines which product APIs
// the token targets. We include both so the agent can use either.
export const ATLASSIAN_AUDIENCE = "api.atlassian.com";

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const p = new URLSearchParams({
    audience: ATLASSIAN_AUDIENCE,
    client_id: opts.clientId,
    scope: ATLASSIAN_SCOPES.join(" "),
    redirect_uri: opts.redirectUri,
    response_type: "code",
    prompt: "consent",
    state: opts.state,
  });
  return `https://auth.atlassian.com/authorize?${p.toString()}`;
}

// Exchange the authorization code for an access_token + refresh_token via
// Atlassian's OAuth token endpoint.
export async function exchangeCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}> {
  const clientId = sanitizeOAuthInput(opts.clientId) ?? "";
  const clientSecret = sanitizeOAuthInput(opts.clientSecret) ?? "";
  const body = JSON.stringify({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
  const res = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const parsed = parseJsonSafe<Record<string, unknown>>(text, {});
  if (!res.ok) {
    const err =
      (parsed["error_description"] as string) ||
      (parsed["error"] as string) ||
      text ||
      `HTTP ${res.status}`;
    console.error(
      `[atlassian-oauth] token exchange rejected (${res.status}): ${err} | client_id ${secretFingerprint(clientId)}`,
    );
    throw new Error(err);
  }
  return parsed as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };
}

// Use refresh_token to get a new access_token when the current one expires.
export async function refreshAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{
  access_token: string;
  expires_in: number;
  scope: string;
}> {
  const clientId = sanitizeOAuthInput(opts.clientId) ?? "";
  const clientSecret = sanitizeOAuthInput(opts.clientSecret) ?? "";
  const body = JSON.stringify({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: opts.refreshToken,
  });
  const res = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const parsed = parseJsonSafe<Record<string, unknown>>(text, {});
  if (!res.ok) {
    const err =
      (parsed["error_description"] as string) ||
      (parsed["error"] as string) ||
      text ||
      `HTTP ${res.status}`;
    console.error(
      `[atlassian-oauth] token refresh rejected (${res.status}): ${err} | client_id ${secretFingerprint(clientId)}`,
    );
    throw new Error(err);
  }
  return parsed as {
    access_token: string;
    expires_in: number;
    scope: string;
  };
}

// Fetch accessible Atlassian resources (cloud sites) using the access token.
// Returns the list of sites the token has access to with their cloud IDs.
export async function getAccessibleResources(
  accessToken: string,
): Promise<Array<{ id: string; url: string; name: string; scopes: string[]; avatarUrl: string }>> {
  const res = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Failed to fetch accessible resources: ${res.status} ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as Array<{
    id: string;
    url: string;
    name: string;
    scopes: string[];
    avatarUrl: string;
  }>;
}

// Get current user info from Atlassian.
export async function getUserInfo(
  accessToken: string,
): Promise<{ name: string; email: string; account_id: string }> {
  const res = await fetch("https://api.atlassian.com/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Failed to fetch user info: ${res.status} ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as { name: string; email: string; account_id: string };
}

// ---------------------------------------------------------------------------
// Shared Atlassian Cloud auth helpers
// ---------------------------------------------------------------------------

export interface AtlassianAuth {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  cloud_id?: string;
}

export function resolveAtlassianAuth(
  integrationName?: string,
): AtlassianAuth | { error: string } {
  const name = integrationName ?? "atlassian";
  const envId = process.env.ATLASSIAN_CLIENT_ID;
  const envSecret = process.env.ATLASSIAN_CLIENT_SECRET;
  const envRefresh = process.env.ATLASSIAN_REFRESH_TOKEN;
  if (envId && envSecret && envRefresh) {
    return {
      client_id: envId,
      client_secret: envSecret,
      refresh_token: envRefresh,
    };
  }
  const saved = getIntegrationRaw(name);
  if (saved?.client_id && saved.client_secret && saved.refresh_token) {
    return {
      client_id: saved.client_id,
      client_secret: saved.client_secret,
      refresh_token: saved.refresh_token,
      cloud_id: saved.cloud_id as string | undefined,
    };
  }
  return {
    error:
      "Atlassian account not connected. Open the gear menu → Integrations tab → " +
      "Atlassian card and click Connect Atlassian to authorize Jira + Confluence access.",
  };
}

// Token cache — shared by the Atlassian Graph / Jira / Confluence tools that
// need a live bearer token without hitting the refresh endpoint every call.
interface CachedAccessToken {
  token: string;
  expires_at: number;
}
const accessTokenCache = new Map<string, CachedAccessToken>();

export function bustAccessToken(auth: AtlassianAuth): void {
  accessTokenCache.delete(auth.refresh_token.slice(0, 20));
}

export async function getAtlassianAccessToken(
  auth: AtlassianAuth,
): Promise<string | { error: string }> {
  const key = auth.refresh_token.slice(0, 20);
  const cached = accessTokenCache.get(key);
  if (cached && cached.expires_at > Date.now() + 60_000) return cached.token;

  try {
    const tok = await refreshAccessToken({
      clientId: auth.client_id,
      clientSecret: auth.client_secret,
      refreshToken: auth.refresh_token,
    });
    const expires_at = Date.now() + (tok.expires_in ?? 3600) * 1000;
    accessTokenCache.set(key, { token: tok.access_token, expires_at });
    return tok.access_token;
  } catch (err) {
    return { error: `Atlassian OAuth refresh failed: ${errorMessage(err)}` };
  }
}

// Generic authed fetch for Atlassian REST APIs. Resolves an access token,
// attaches it as a Bearer header, and returns parsed JSON or an error shape.
export async function atlassianFetch(
  auth: AtlassianAuth,
  pathOrUrl: string,
  init?: RequestInit,
): Promise<unknown> {
  const token = await getAtlassianAccessToken(auth);
  if (typeof token !== "string") return token;

  let url: string;
  if (pathOrUrl.startsWith("http")) {
    url = pathOrUrl;
  } else {
    // Default to Jira/Confluence via the cloud gateway.
    const base = auth.cloud_id
      ? `https://api.atlassian.com/ex/jira/${auth.cloud_id}`
      : "https://api.atlassian.com";
    url = `${base}${pathOrUrl}`;
  }

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
      return { error: `Atlassian ${res.status}: ${text.slice(0, 500)}`, url };
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    return { error: `Atlassian fetch threw: ${errorMessage(err)}` };
  }
}