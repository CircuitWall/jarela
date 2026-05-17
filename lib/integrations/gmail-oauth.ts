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

import { randomBytes } from "crypto";

export interface OAuthFlow {
  createdAt: number;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  status: "pending" | "done" | "error";
  error?: string;
}

const FLOW_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_FLOWS = 32;

type Store = Map<string, OAuthFlow>;

const g = globalThis as unknown as { __ggOauthFlows?: Store };
if (!g.__ggOauthFlows) g.__ggOauthFlows = new Map();
const flows: Store = g.__ggOauthFlows;

function gc() {
  const now = Date.now();
  for (const [k, v] of flows) {
    if (now - v.createdAt > FLOW_TTL_MS) flows.delete(k);
  }
  // Hard cap so a stuck UI can't grow this unbounded.
  if (flows.size > MAX_FLOWS) {
    const oldest = [...flows.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (let i = 0; i < oldest.length - MAX_FLOWS; i++) flows.delete(oldest[i][0]);
  }
}

export function createFlow(input: { clientId: string; clientSecret: string; redirectUri: string }): {
  state: string;
  flow: OAuthFlow;
} {
  gc();
  const state = randomBytes(16).toString("hex");
  const flow: OAuthFlow = {
    createdAt: Date.now(),
    status: "pending",
    ...input,
  };
  flows.set(state, flow);
  return { state, flow };
}

export function getFlow(state: string): OAuthFlow | undefined {
  gc();
  return flows.get(state);
}

export function updateFlow(state: string, patch: Partial<OAuthFlow>): void {
  const f = flows.get(state);
  if (f) Object.assign(f, patch);
}

export function deleteFlow(state: string): void {
  flows.delete(state);
}

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
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
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text); } catch { /* leave empty */ }
  if (!res.ok) {
    const err = (parsed["error_description"] || parsed["error"] || text || `HTTP ${res.status}`) as string;
    throw new Error(err);
  }
  return parsed as { refresh_token?: string; access_token?: string; expires_in?: number; scope?: string };
}
