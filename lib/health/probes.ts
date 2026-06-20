// Pure probe functions: given a configured integration or LLM provider,
// hit the cheapest authoritative endpoint and return a structured
// `HealthResult`. No NextResponse coupling, no UI coupling — callable
// from the HTTP route (/api/v1/integrations/[name]/test), the periodic
// health runner (lib/health/runner.ts), and the on-demand /api/v1/health
// route. See ./runner.ts for the cooldown/notification layer.
//
// Each probe is the lightest end-to-end auth check the vendor exposes
// (myself / labels.list / models?pageSize=1 / etc) so it can be polled
// every few minutes without burning quota.

import { resolvePackageAuth } from "@/lib/tools/auth-registry";
import type { AtlassianAuth } from "@circuitwall/atlassian-langchain";
import type { GitHubAuth } from "@circuitwall/github-langchain";
import type { JiraAlignAuth } from "@circuitwall/jira-align-langchain";
// Trigger registration of the default LangChain package auth resolvers
// before the first probe runs. Health probes can be invoked from the
// scheduler before any agent tool call has caused builtins.ts to load.
// Skip during `next build` page-data collection: parallel workers would
// race on the SQLite migration lock when isPackageDisabled() opens the DB.
import { registerDefaultPackages } from "@/lib/tools/default-packages";
if (process.env.NEXT_PHASE !== "phase-production-build") {
  registerDefaultPackages();
}
import { _resolveGmailAuth } from "@/lib/tools/gmail";
import { _resolveOutlookAuth } from "@/lib/tools/outlook";
import { resolveGoogleTokenEndpoint } from "@/lib/integrations/gmail-oauth";
import { getMicrosoftAccessToken } from "@/lib/integrations/microsoft-oauth";
import { getIntegrationRaw, INTEGRATIONS, type IntegrationName } from "@/lib/stores/integrations";
import { getStoredOAuthToken as getStoredCopilotOAuthToken } from "@/lib/providers/github-copilot-auth";

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export type HealthCategory = "integration" | "llm";

export interface HealthResult {
  ok: boolean;
  error?: string;
  detail?: Record<string, unknown>;
  // Distinguishes "credentials missing" from "credentials rejected" so the
  // runner can stay silent for the former (operator never configured the
  // integration) while alerting on the latter (configured but broken).
  status: "ok" | "unconfigured" | "auth_failed" | "transient" | "error";
}

function ok(detail?: Record<string, unknown>): HealthResult {
  return { ok: true, status: "ok", detail };
}
function unconfigured(error: string): HealthResult {
  return { ok: false, status: "unconfigured", error };
}
function authFailed(error: string): HealthResult {
  return { ok: false, status: "auth_failed", error };
}
function transient(error: string): HealthResult {
  return { ok: false, status: "transient", error };
}
function probeError(error: string): HealthResult {
  return { ok: false, status: "error", error };
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return code ? `${err.message}: ${cause.message} (${code})` : `${err.message}: ${cause.message}`;
  }
  return err.message;
}

function probeSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

// ────────────────────────────────────────────────────────────────────
// Integration probes (six configured services)
// ────────────────────────────────────────────────────────────────────

export async function probeAtlassian(): Promise<HealthResult> {
  const auth = resolvePackageAuth<AtlassianAuth>("atlassian");
  if ("error" in auth) return unconfigured(auth.error);
  try {
    const res = await fetch(`${auth.url}/rest/api/3/myself`, {
      headers: {
        Authorization: "Basic " + Buffer.from(`${auth.email}:${auth.apiToken}`).toString("base64"),
        Accept: "application/json",
      },
      signal: probeSignal(DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return authFailed(`Atlassian rejected the API token (${res.status}). Regenerate at id.atlassian.com → Security → API tokens.`);
    }
    if (res.status === 429) return transient(`Atlassian rate-limited the probe (429).`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return probeError(`Atlassian ${res.status}: ${body.slice(0, 200)}`);
    }
    const me = (await res.json()) as { displayName?: string; emailAddress?: string; accountId?: string };
    return ok({ displayName: me.displayName, email: me.emailAddress, accountId: me.accountId });
  } catch (err) {
    return transient(describeError(err));
  }
}

export async function probeJiraAlign(): Promise<HealthResult> {
  const auth = resolvePackageAuth<JiraAlignAuth>("jira_align");
  if ("error" in auth) return unconfigured(auth.error);
  try {
    const res = await fetch(`${auth.url}/rest/align/api/2/programs?limit=1`, {
      headers: { Authorization: `Bearer ${auth.apiToken}`, Accept: "application/json" },
      signal: probeSignal(DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (res.status === 401) return authFailed(`Jira Align rejected the token (401). Re-issue in Settings → Personal Access Tokens.`);
    if (res.status === 403) {
      // Auth ok, just no read scope on programs.
      return ok({ note: "token authenticated but has no read access on /programs — agent may still work for other endpoints" });
    }
    if (res.status === 429) return transient(`Jira Align rate-limited the probe (429).`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return probeError(`Jira Align ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { items?: unknown[] };
    return ok({ url: auth.url, sample_programs: Array.isArray(data.items) ? data.items.length : 0 });
  } catch (err) {
    return transient(describeError(err));
  }
}

export async function probeGithub(): Promise<HealthResult> {
  const auth = resolvePackageAuth<GitHubAuth>("github");
  if ("error" in auth) return unconfigured(auth.error);
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Jarela",
      },
      signal: probeSignal(DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return authFailed(`GitHub rejected the Personal Access Token (${res.status}). Regenerate at github.com/settings/tokens.`);
    }
    if (res.status === 429) return transient(`GitHub rate-limited the probe (429).`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return probeError(`GitHub ${res.status}: ${body.slice(0, 200)}`);
    }
    const me = (await res.json()) as { login?: string; name?: string | null; type?: string };
    return ok({ login: me.login, name: me.name ?? null, type: me.type });
  } catch (err) {
    return transient(describeError(err));
  }
}

export async function probeGoogle(): Promise<HealthResult> {
  const raw = getIntegrationRaw("google");
  const apiKey = raw?.api_key?.trim();
  if (!apiKey) return unconfigured("API key not configured");
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1`;
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: probeSignal(DEFAULT_PROBE_TIMEOUT_MS) });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return authFailed(`Google AI rejected the API key (${res.status}). Regenerate at aistudio.google.com → API keys.`);
    }
    if (res.status === 429) return transient(`Google AI rate-limited the probe (429).`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return probeError(`Google AI ${res.status}: ${body.slice(0, 200)}`);
    }
    return ok({ displayName: "Google AI" });
  } catch (err) {
    return transient(describeError(err));
  }
}

export async function probeGmail(): Promise<HealthResult> {
  const auth = _resolveGmailAuth();
  if ("error" in auth) return unconfigured(auth.error);
  try {
    const refreshBody = new URLSearchParams({
      client_id: auth.client_id,
      refresh_token: auth.refresh_token,
      grant_type: "refresh_token",
    });
    if (auth.client_secret) refreshBody.set("client_secret", auth.client_secret);
    // Bundled-client traffic must go through Jarela's OAuth proxy, which
    // injects client_secret from Secret Manager. Hitting Google directly
    // for the bundled client fails with "client_secret is missing."
    const endpoint = resolveGoogleTokenEndpoint(auth.client_id, Boolean(auth.client_secret));
    const tokenRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshBody.toString(),
      signal: probeSignal(DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (tokenRes.status === 400 || tokenRes.status === 401) {
      const body = await tokenRes.text().catch(() => "");
      return authFailed(`Gmail refresh token rejected (${tokenRes.status}). Re-run the OAuth setup wizard. ${body.slice(0, 200)}`);
    }
    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      return probeError(`OAuth refresh failed ${tokenRes.status}: ${body.slice(0, 200)}`);
    }
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (!access_token) return probeError("OAuth response missing access_token");
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
      headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" },
      signal: probeSignal(DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return authFailed(`Gmail rejected the access token (${res.status}).`);
    }
    if (res.status === 429) return transient(`Gmail rate-limited the probe (429).`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return probeError(`Gmail ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { labels?: Array<{ id: string; name: string }> };
    return ok({ labels: data.labels?.length ?? 0 });
  } catch (err) {
    return transient(describeError(err));
  }
}

export async function probeOutlook(): Promise<HealthResult> {
  const auth = _resolveOutlookAuth();
  if ("error" in auth) return unconfigured(auth.error);
  try {
    const token = await getMicrosoftAccessToken(auth);
    if (typeof token !== "string") return authFailed(token.error);
    const res = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: probeSignal(DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return authFailed(`Microsoft Graph rejected the token (${res.status}). The refresh token may have expired — re-run OAuth setup.`);
    }
    if (res.status === 429) return transient(`Microsoft Graph rate-limited the probe (429).`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return probeError(`Graph ${res.status}: ${body.slice(0, 200)}`);
    }
    const me = (await res.json()) as { displayName?: string; mail?: string; userPrincipalName?: string };
    return ok({ displayName: me.displayName, email: me.mail ?? me.userPrincipalName });
  } catch (err) {
    return transient(describeError(err));
  }
}

// ────────────────────────────────────────────────────────────────────
// iCloud (CalDAV PROPFIND with HTTP Basic — apple_id + app_password)
// ────────────────────────────────────────────────────────────────────

export async function probeICloud(): Promise<HealthResult> {
  const raw = getIntegrationRaw("icloud");
  const appleId = raw?.apple_id?.trim();
  const appPassword = raw?.app_password?.replace(/[\u200B-\u200D\uFEFF\s-]/g, "");
  if (!appleId || !appPassword) {
    return unconfigured("Apple ID + app-specific password not configured");
  }
  try {
    const auth = "Basic " + Buffer.from(`${appleId}:${appPassword}`).toString("base64");
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
    const res = await fetch("https://caldav.icloud.com/", {
      method: "PROPFIND",
      headers: {
        Authorization: auth,
        Depth: "0",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body,
      signal: probeSignal(DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return authFailed(
        `iCloud rejected the credentials (${res.status}). The app-specific password may have been ` +
          "revoked or the Apple ID has 2FA disabled. Generate a new one at appleid.apple.com.",
      );
    }
    if (res.status === 429) return transient("iCloud rate-limited the probe (429).");
    // iCloud returns 207 Multi-Status on success.
    if (res.status !== 207 && !res.ok) {
      const text = await res.text().catch(() => "");
      return probeError(`iCloud CalDAV ${res.status}: ${text.slice(0, 200)}`);
    }
    return ok({ host: "caldav.icloud.com" });
  } catch (err) {
    return transient(describeError(err));
  }
}

// ────────────────────────────────────────────────────────────────────
// LLM-provider key probes (anthropic / openai / google / deepseek)
// ────────────────────────────────────────────────────────────────────

export async function probeAnthropic(): Promise<HealthResult> {
  const key = getIntegrationRaw("anthropic")?.api_key?.trim();
  if (!key) return unconfigured("API key not configured");
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: probeSignal(DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return authFailed("Anthropic rejected the API key (401/403). Regenerate at console.anthropic.com.");
    }
    if (res.status === 429) return transient("Anthropic rate-limited the probe (429).");
    if (!res.ok) return probeError(`Anthropic returned ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return ok({ models: (data.data ?? []).map((m) => m.id).length });
  } catch (err) {
    return transient(describeError(err));
  }
}

export async function probeOpenAI(): Promise<HealthResult> {
  // Prefer the integration store (set via the Integrations panel) and
  // fall back to OPENAI_API_KEY for setups that only export the env var.
  const key = getIntegrationRaw("openai")?.api_key?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!key) return unconfigured("API key not configured");
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: probeSignal(DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return authFailed("OpenAI rejected the API key (401). Verify at platform.openai.com/api-keys.");
    }
    if (res.status === 429) return transient("OpenAI rate-limited the probe (429).");
    if (!res.ok) return probeError(`OpenAI returned ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return ok({ models: (data.data ?? []).length });
  } catch (err) {
    return transient(describeError(err));
  }
}

export async function probeDeepseek(): Promise<HealthResult> {
  const key = getIntegrationRaw("deepseek")?.api_key?.trim() || process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) return unconfigured("API key not configured");
  try {
    const res = await fetch("https://api.deepseek.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: probeSignal(DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return authFailed("DeepSeek rejected the API key (401).");
    }
    if (res.status === 429) return transient("DeepSeek rate-limited the probe (429).");
    if (!res.ok) return probeError(`DeepSeek returned ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return ok({ models: (data.data ?? []).length });
  } catch (err) {
    return transient(describeError(err));
  }
}

export async function probeCohere(): Promise<HealthResult> {
  const key = getIntegrationRaw("cohere")?.api_key?.trim() || process.env.COHERE_API_KEY?.trim();
  if (!key) return unconfigured("API key not configured");
  try {
    const res = await fetch("https://api.cohere.com/v1/models", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: probeSignal(DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return authFailed("Cohere rejected the API key (401). Regenerate at dashboard.cohere.com → API keys.");
    }
    if (res.status === 429) return transient("Cohere rate-limited the probe (429).");
    if (!res.ok) return probeError(`Cohere returned ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return ok({ models: (data.models ?? []).length });
  } catch (err) {
    return transient(describeError(err));
  }
}

export async function probeGithubCopilot(): Promise<HealthResult> {
  // Two credential paths share this probe:
  //   1. Device-flow OAuth token (stored under memory_store namespace
  //      "github-copilot-auth" by the in-app sign-in). Verified by
  //      exchanging it for a Copilot session token.
  //   2. Personal Access Token saved via the Integrations panel.
  //      PATs cannot be exchanged, so we check them against the GitHub
  //      Models REST surface which Copilot PATs are routed to.
  const oauth = getStoredCopilotOAuthToken();
  if (oauth) {
    try {
      const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
        headers: { Authorization: `token ${oauth}`, "User-Agent": "Jarela" },
        signal: probeSignal(DEFAULT_PROBE_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        return authFailed(`GitHub rejected the Copilot OAuth token (${res.status}). Sign in again from the Models panel.`);
      }
      if (res.status === 404) {
        return authFailed("GitHub Copilot subscription not found for this account.");
      }
      if (res.status === 429) return transient("GitHub Copilot rate-limited the probe (429).");
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return probeError(`GitHub Copilot ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as { expires_at?: string };
      return ok({ auth: "oauth", session_expires_at: json.expires_at ?? null });
    } catch (err) {
      return transient(describeError(err));
    }
  }
  const pat = getIntegrationRaw("github-copilot")?.api_key?.trim();
  if (!pat) return unconfigured("Not signed in and no PAT configured");
  try {
    const res = await fetch("https://models.github.ai/catalog/models", {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "Jarela",
      },
      signal: probeSignal(DEFAULT_PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return authFailed(`GitHub rejected the PAT (${res.status}). Confirm the token has the "copilot" scope and your subscription is active.`);
    }
    if (res.status === 429) return transient("GitHub rate-limited the probe (429).");
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return probeError(`GitHub Models ${res.status}: ${body.slice(0, 200)}`);
    }
    return ok({ auth: "pat" });
  } catch (err) {
    return transient(describeError(err));
  }
}

// ────────────────────────────────────────────────────────────────────
// Routing helpers
// ────────────────────────────────────────────────────────────────────

export type ProbeName =
  | "atlassian" | "jira_align" | "github" | "google" | "gmail" | "outlook" | "icloud"
  | "anthropic" | "openai" | "deepseek" | "cohere" | "github-copilot";

const ALL_PROBES: Record<ProbeName, () => Promise<HealthResult>> = {
  atlassian: probeAtlassian,
  jira_align: probeJiraAlign,
  github: probeGithub,
  google: probeGoogle,
  gmail: probeGmail,
  outlook: probeOutlook,
  icloud: probeICloud,
  anthropic: probeAnthropic,
  openai: probeOpenAI,
  deepseek: probeDeepseek,
  cohere: probeCohere,
  "github-copilot": probeGithubCopilot,
};

const PROBE_LABELS: Record<ProbeName, string> = {
  atlassian: "Atlassian (Jira + Confluence)",
  jira_align: "Jira Align",
  github: "GitHub",
  google: "Google AI (Gemini + Imagen)",
  gmail: "Gmail + Calendar",
  outlook: "Outlook + Calendar",
  icloud: "iCloud Mail + Calendar + Reminders",
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  cohere: "Cohere",
  "github-copilot": "GitHub Copilot",
};

const PROBE_CATEGORY: Record<ProbeName, HealthCategory> = {
  atlassian: "integration",
  jira_align: "integration",
  github: "integration",
  google: "llm",
  gmail: "integration",
  outlook: "integration",
  icloud: "integration",
  anthropic: "llm",
  openai: "llm",
  deepseek: "llm",
  cohere: "llm",
  "github-copilot": "llm",
};

export function listProbes(): ProbeName[] {
  return Object.keys(ALL_PROBES) as ProbeName[];
}

export function probeLabel(name: ProbeName): string {
  return PROBE_LABELS[name];
}

export function probeCategory(name: ProbeName): HealthCategory {
  return PROBE_CATEGORY[name];
}

export async function runProbe(name: ProbeName): Promise<HealthResult> {
  return ALL_PROBES[name]();
}

// Convenience: only known integration probes (used by the existing
// /api/v1/integrations/[name]/test route which is keyed by integration name).
export function isIntegrationProbe(name: string): name is IntegrationName & ProbeName {
  return Object.prototype.hasOwnProperty.call(INTEGRATIONS, name) && Object.prototype.hasOwnProperty.call(ALL_PROBES, name);
}
