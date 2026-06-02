// Auth + REST plumbing shared by every Atlassian tool. Split out of the
// monolithic lib/tools/atlassian.ts in the bloat-audit refactor; the public
// surface (AtlassianAuth, _resolveAtlassianAuth, _atlassianFetch) is
// re-exported from lib/tools/atlassian.ts so existing imports keep working.

import { getIntegrationRaw } from "@/lib/stores/integrations";
import { parseJsonSafe } from "@/lib/utils/json";
import { httpStatusToErrorCode, parseRetryAfterMs, networkErrorCode } from "../error-codes";

export interface AtlassianAuth {
  url: string;        // e.g. "https://your-team.atlassian.net"
  email: string;
  apiToken: string;
}

// Exposed so the integrations test endpoint can probe the live API after save.
export function _resolveAtlassianAuth(): AtlassianAuth | { error: string } {
  return resolveAuth();
}

export function resolveAuth(): AtlassianAuth | { error: string } {
  // Env first (deployment-level config, wins over per-user secrets stored in DB)
  const envUrl = process.env.ATLASSIAN_URL;
  const envEmail = process.env.ATLASSIAN_EMAIL;
  const envToken = process.env.ATLASSIAN_API_TOKEN;
  if (envUrl && envEmail && envToken) {
    return { url: stripTrailingSlash(envUrl), email: envEmail, apiToken: envToken };
  }
  // Saved integration creds (from the Integrations panel in the UI).
  const saved = getIntegrationRaw("atlassian");
  if (saved?.url && saved.email && saved.api_token) {
    return { url: stripTrailingSlash(saved.url), email: saved.email, apiToken: saved.api_token };
  }
  return {
    error:
      "Atlassian not configured. Open the gear menu → Integrations tab and add your Atlassian site URL, " +
      "email, and API token. (Or set ATLASSIAN_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN env vars.)",
  };
}

function stripTrailingSlash(s: string): string { return s.replace(/\/+$/, ""); }

export function authHeader(a: AtlassianAuth): string {
  return "Basic " + Buffer.from(`${a.email}:${a.apiToken}`).toString("base64");
}

// Sibling-module accessor: the remote document-RAG indexers (lib/documents/
// remote/{jira,confluence}.ts, ADR-0026) reuse the same proxy-aware fetch
// wrapper + auth header so they don't duplicate the Atlassian REST plumbing.
// Underscore prefix marks it as "internal API, but reachable across modules".
export async function _atlassianFetch(
  auth: AtlassianAuth,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  return atlassianFetch(auth, path, init);
}

// Sibling-importable inside lib/tools/atlassian/. Public access still goes
// through `_atlassianFetch` re-exported from lib/tools/atlassian.ts.
export async function atlassianFetch(
  auth: AtlassianAuth,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${auth.url}${path}`;
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: authHeader(auth),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      // PR-B — surface a stable error code the agent can branch on
      // (ADR-0049 / ADR-0050 playbook). The HTTP status was previously
      // buried in the message text; the agent had to regex it out to
      // distinguish 401 (bad creds, tell user) from 429 (rate-limit, retry)
      // from 5xx (transient, retry).
      const code = httpStatusToErrorCode(res.status);
      const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res.headers.get("retry-after")) : undefined;
      return {
        error: `Atlassian ${res.status}: ${text.slice(0, 500)}`,
        code,
        status: res.status,
        url,
        ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
      };
    }
    return parseJsonSafe<unknown>(text, text);
  } catch (err) {
    const code = networkErrorCode(err) ?? ((err as { name?: string }).name === "AbortError" ? "tool_timeout" : "fetch_error");
    return {
      error: `Atlassian fetch threw: ${err instanceof Error ? err.message : String(err)}`,
      code,
      url,
    };
  }
}

