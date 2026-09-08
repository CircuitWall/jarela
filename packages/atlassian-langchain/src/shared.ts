/**
 * Shared auth + fetch primitives for the Atlassian toolset.
 */

export interface AtlassianAuth {
  url: string;
  email: string;
  apiToken: string;
}

export type AuthResolver = () => AtlassianAuth | { error: string };

let _resolver: AuthResolver = resolveAtlassianAuthFromEnv;

export function setAuthResolver(fn: AuthResolver): void {
  _resolver = fn;
}

export function resolveAtlassianAuthFromEnv(): AtlassianAuth | { error: string } {
  const envUrl = process.env.ATLASSIAN_URL;
  const envEmail = process.env.ATLASSIAN_EMAIL;
  const envToken = process.env.ATLASSIAN_API_TOKEN;
  if (envUrl && envEmail && envToken) {
    return { url: stripTrailingSlash(envUrl), email: envEmail, apiToken: envToken };
  }
  return {
    error:
      "Atlassian not configured. Set ATLASSIAN_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN env vars, " +
      "or call setAuthResolver() with your own credential provider.",
  };
}

export function resolveAuth(): AtlassianAuth | { error: string } {
  return _resolver();
}

function stripTrailingSlash(s: string): string { return s.replace(/\/+$/, ""); }

export function authHeader(a: AtlassianAuth): string {
  return "Basic " + Buffer.from(`${a.email}:${a.apiToken}`).toString("base64");
}

export function parseJsonSafe<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export async function atlassianFetch(
  auth: AtlassianAuth,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${auth.url}${path}`;
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
    return { error: `Atlassian ${res.status}: ${text.slice(0, 500)}`, url };
  }
  return parseJsonSafe<unknown>(text, text);
}
