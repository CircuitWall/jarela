// Thin wrapper over memory_store for integration credentials. The data lives
// under namespace="integrations", key=<integration name>, value=<JSON>. We
// reuse memory_store so the existing Atlassian tool's fallback resolution
// path "just works" without a second source of truth.
//
// Secret fields are echoed back to clients as a fixed sentinel string so
// nothing sensitive ends up in the UI / network logs / browser inspector.

import { getMemory, putMemory, deleteMemory, listMemory } from "@/lib/stores/memory";
import { getIntegrationMeta, markFieldsAsUserTouched } from "@/lib/stores/integration_meta";

export const SECRET_MASK = "********";
const NAMESPACE = "integrations";

// Per-integration shape. Adding a new integration means:
//   1. Add an entry here naming its fields and which are secrets.
//   2. The Atlassian tool (or a future tool) reads via getIntegration().
export const INTEGRATIONS = {
  atlassian: {
    label: "Atlassian (Jira + Confluence)",
    description: "Used by jira_* and confluence_* tools. Get an API token at id.atlassian.com → Security → API tokens.",
    fields: [
      { key: "url", label: "Site URL", placeholder: "https://your-team.atlassian.net", secret: false, required: true },
      { key: "email", label: "Account email", placeholder: "you@company.com", secret: false, required: true },
      { key: "api_token", label: "API token", placeholder: "ATATT3xFfGF0…", secret: true, required: true },
    ],
  },
  google: {
    label: "Google AI (Gemini + Imagen)",
    description: "Used by the generate_image tool (Gemini / Imagen). Get a key at aistudio.google.com → API keys.",
    fields: [
      { key: "api_key", label: "API key", placeholder: "AIza…", secret: true, required: true },
    ],
  },
  gmail: {
    label: "Gmail + Calendar",
    description:
      "Used by the gmail_* and calendar_* tools (search/read/draft/label/archive mail; " +
      "list/create/update/delete calendar events). Drafts only \u2014 this integration " +
      "intentionally cannot send mail. See the Setup guide below for how to create the " +
      "OAuth client. Existing connections must reconnect to grant the new Calendar scope.",
    fields: [
      { key: "client_id", label: "OAuth client ID", placeholder: "<id>.apps.googleusercontent.com", secret: false, required: true },
      { key: "client_secret", label: "OAuth client secret", placeholder: "GOCSPX-…", secret: true, required: true },
      { key: "refresh_token", label: "Refresh token", placeholder: "1//0…", secret: true, required: true },
    ],
  },  github: {
    label: "GitHub",
    description:
      "Used by github_* tools (search/read/create/comment on issues + PRs, list PRs, get repo info). " +
      "Create a Personal Access Token at github.com/settings/tokens. Scopes: `repo` (private repos) or " +
      "`public_repo` (public only); add `read:org` if you target org repos.",
    fields: [
      { key: "token", label: "Personal Access Token", placeholder: "ghp_… or github_pat_…", secret: true, required: true },
    ],
  },
  outlook: {
    label: "Outlook + Calendar",
    description:
      "Used by the outlook_* and outlook_calendar_* tools (search/read/draft/move/trash mail; " +
      "list/create/update/delete calendar events). Drafts only — this integration intentionally " +
      "cannot send mail. Requires an Azure app registration. See the Setup guide below.",
    fields: [
      { key: "client_id", label: "Application (client) ID", placeholder: "00000000-0000-0000-0000-000000000000", secret: false, required: true },
      { key: "client_secret", label: "Client secret value", placeholder: "abc~…", secret: true, required: true },
      { key: "refresh_token", label: "Refresh token", placeholder: "0.AXoA…", secret: true, required: true },
    ],
  },} as const;

export type IntegrationName = keyof typeof INTEGRATIONS;

export function isKnownIntegration(name: string): name is IntegrationName {
  return Object.prototype.hasOwnProperty.call(INTEGRATIONS, name);
}

export interface IntegrationStatus {
  name: string;
  configured: boolean;
  values: Record<string, string>; // secrets masked
  updated_at: string | null;
  /**
   * Per-field provenance. `"rc"` = pulled from a shell rc / Windows
   * registry env var by the env-syncer. `"user"` = the user typed it
   * into the panel. Absent fields haven't been seen by either path.
   * Drives the "from your shell" badge in the IntegrationsPanel.
   */
  source?: Record<string, "rc" | "user">;
  /** Last successful rc-sync write time, ISO. Null until the first sync. */
  rc_synced_at?: string | null;
}

export function listIntegrations(): IntegrationStatus[] {
  const rows = listMemory(NAMESPACE, undefined, 100);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return Object.keys(INTEGRATIONS).map((name) => {
    const row = byKey.get(name);
    const meta = getIntegrationMeta(name);
    if (!row) {
      return {
        name,
        configured: false,
        values: {},
        updated_at: null,
        source: meta.source,
        rc_synced_at: meta.rc_synced_at,
      };
    }
    return {
      name,
      configured: true,
      values: maskSecrets(name as IntegrationName, parseValue(row.value)),
      updated_at: row.updated_at,
      source: meta.source,
      rc_synced_at: meta.rc_synced_at,
    };
  });
}

export function getIntegrationStatus(name: string): IntegrationStatus | null {
  if (!isKnownIntegration(name)) return null;
  const row = getMemory(NAMESPACE, name);
  const meta = getIntegrationMeta(name);
  if (!row) {
    return {
      name,
      configured: false,
      values: {},
      updated_at: null,
      source: meta.source,
      rc_synced_at: meta.rc_synced_at,
    };
  }
  return {
    name,
    configured: true,
    values: maskSecrets(name, parseValue(row.value)),
    updated_at: row.updated_at,
    source: meta.source,
    rc_synced_at: meta.rc_synced_at,
  };
}

// Internal: server-side resolution that returns RAW secrets. Only callable
// from server code (the integration tools).
export function getIntegrationRaw(name: string): Record<string, string> | null {
  const row = getMemory(NAMESPACE, name);
  if (!row) return null;
  return parseValue(row.value);
}

// Save credentials. Any field whose value matches SECRET_MASK is preserved
// from the existing record (so unchanged secret fields don't get blanked
// when the UI sends back the masked form).
export function saveIntegration(name: string, incoming: Record<string, string>): IntegrationStatus | { error: string } {
  if (!isKnownIntegration(name)) return { error: `unknown integration "${name}"` };
  const def = INTEGRATIONS[name];
  const existing = getIntegrationRaw(name) ?? {};
  const merged: Record<string, string> = {};
  // Track which fields the user actually changed (vs preserved via SECRET_MASK).
  // Only changed fields flip source to "user" — if they re-saved without
  // touching the secret, it stays whatever it was (rc or user).
  const touched: string[] = [];
  for (const f of def.fields) {
    const v = incoming[f.key];
    if (v === undefined) {
      if (existing[f.key]) merged[f.key] = existing[f.key];
      else if (f.required) return { error: `missing required field "${f.key}"` };
      continue;
    }
    if (f.secret && v === SECRET_MASK) {
      // UI returned masked sentinel — keep existing secret untouched.
      if (existing[f.key]) merged[f.key] = existing[f.key];
      else if (f.required) return { error: `missing required secret "${f.key}"` };
    } else {
      if (f.required && !v.trim()) return { error: `"${f.key}" cannot be empty` };
      merged[f.key] = v;
      if (existing[f.key] !== v) touched.push(f.key);
    }
  }
  putMemory(NAMESPACE, name, merged);
  if (touched.length > 0) markFieldsAsUserTouched(name, touched);
  return getIntegrationStatus(name)!;
}

export function deleteIntegration(name: string): boolean {
  if (!isKnownIntegration(name)) return false;
  return deleteMemory(NAMESPACE, name);
}

function parseValue(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch { /* */ }
  return {};
}

function maskSecrets(name: IntegrationName, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of INTEGRATIONS[name].fields) {
    const v = values[f.key];
    if (v === undefined) continue;
    out[f.key] = f.secret ? SECRET_MASK : v;
  }
  return out;
}
