/**
 * Shared auth + fetch primitives for the Atlassian toolset.
 */

export interface AtlassianAuth {
  url: string;
  email: string;
  apiToken: string;
  cloudId?: string;
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
  const cloudId = process.env.ATLASSIAN_CLOUD_ID;
  if (envUrl && envEmail && envToken) {
    return { url: stripTrailingSlash(envUrl), email: envEmail, apiToken: envToken, ...(cloudId ? { cloudId } : {}) };
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
  const target = resolveAtlassianUrl(auth, path);
  if ("error" in target) return target;
  const { url, external } = target;
  const res = await fetch(url, {
    ...init,
    ...(external ? { redirect: "error" as const } : {}),
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

export function resolveAtlassianUrl(
  auth: AtlassianAuth,
  path: string,
): { url: string; external: boolean } | { error: string } {
  let site: URL;
  let target: URL;
  try {
    site = new URL(auth.url);
    target = new URL(path, `${stripTrailingSlash(auth.url)}/`);
  } catch {
    return { error: "Atlassian site URL or request URL is invalid." };
  }
  if (site.protocol !== "https:" && !(site.protocol === "http:" && site.hostname === "localhost")) {
    return { error: "Atlassian site URL must use HTTPS." };
  }
  if (target.origin !== site.origin || target.username || target.password) {
    return { error: "Atlassian requests must target the configured site; refusing to forward credentials." };
  }
  if (auth.cloudId && target.pathname.startsWith("/wiki/")) {
    target = new URL(`https://api.atlassian.com/ex/confluence/${encodeURIComponent(auth.cloudId)}${target.pathname}${target.search}${target.hash}`);
  } else if (auth.cloudId && (target.pathname.startsWith("/rest/") || target.pathname.startsWith("/secure/attachment/"))) {
    target = new URL(`https://api.atlassian.com/ex/jira/${encodeURIComponent(auth.cloudId)}${target.pathname}${target.search}${target.hash}`);
  }
  return { url: target.toString(), external: target.origin !== site.origin };
}

export function resolveAttachmentUrl(auth: AtlassianAuth, path: string): string | { error: string } {
  const target = resolveAtlassianUrl(auth, path);
  return "error" in target ? target : target.url;
}

export async function fetchAtlassianAttachment(
  auth: AtlassianAuth,
  path: string,
): Promise<Response | { error: string }> {
  const initialUrl = resolveAttachmentUrl(auth, path);
  if (typeof initialUrl !== "string") return initialUrl;
  const credentialOrigin = new URL(initialUrl).origin;
  let currentUrl = new URL(initialUrl);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const headers = new Headers();
    if (currentUrl.origin === credentialOrigin) headers.set("Authorization", authHeader(auth));
    const response = await fetch(currentUrl, { headers, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === 5) return { error: "Atlassian attachment exceeded the redirect limit." };
    await response.body?.cancel();
    try {
      const nextUrl = new URL(location, currentUrl);
      if ((nextUrl.protocol !== "https:" && !(nextUrl.protocol === "http:" && nextUrl.hostname === "localhost"))
        || nextUrl.username || nextUrl.password) {
        return { error: "Atlassian attachment redirected to an unsafe URL." };
      }
      currentUrl = nextUrl;
    } catch {
      return { error: "Atlassian attachment returned an invalid redirect URL." };
    }
  }
  return { error: "Atlassian attachment exceeded the redirect limit." };
}
