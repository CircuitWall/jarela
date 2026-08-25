// Thin wrapper over the typed `credentials` table for integration
// credentials. Each integration name maps to a credential of
// `type='integration'`, `provider=<name>`. When the user has multiple
// instances (e.g. two gmail credentials) the legacy single-instance
// callers resolve to the FIRST one (sorted by id), matching the
// "default = first suitable" rule from the credentials spec.
//
// Pre-migration history: integrations used to live under namespace
// `integrations` in memory_store. The boot-time migration
// `migrateIntegrationsToCredentials` (see lib/db/migrations.ts) lifted
// every legacy row into the credentials table. This module now writes
// only through the credentials table and proactively deletes any
// leftover legacy memory_store rows on save/delete to prevent drift.
//
// Secret fields are echoed back to clients as a fixed sentinel string so
// nothing sensitive ends up in the UI / network logs / browser inspector.

import { deleteMemory } from "@/lib/stores/memory";
import {
  createCredential,
  deleteCredential,
  getCredential,
  getCredentialParams,
  getDefaultCredential,
  listCredentials,
  updateCredential,
} from "@/lib/stores/credentials";
import { getIntegrationMeta, markFieldsAsUserTouched } from "@/lib/stores/integration_meta";
import { getCurrentToolCredentialContext } from "@/lib/tools/credential-context";

export const SECRET_MASK = "********";
const LEGACY_NAMESPACE = "integrations";

// Persona-filter category. Mirrors the category enum in
// lib/integrations/manifest.ts so we can drive the Credentials panel
// off the same vocabulary the agent uses when explaining setup.
//   llm            - LLM provider keys (Google, OpenAI, …)
//   mail           - inbox + draft tools (Gmail, Outlook)
//   calendar       - calendar event tools
//   issue-tracker  - Jira / Jira Align / etc.
//   chat           - messaging bridges (future)
//   infrastructure - GitHub / cloud / k8s / …
//   other          - everything else
export type IntegrationCategory =
  | "llm"
  | "mail"
  | "calendar"
  | "issue-tracker"
  | "chat"
  | "infrastructure"
  | "other";

// Per-integration shape. Adding a new integration means:
//   1. Add an entry here naming its fields and which are secrets.
//   2. The Atlassian tool (or a future tool) reads via getIntegration().
export const INTEGRATIONS = {
  anthropic: {
    label: "Anthropic (Claude)",
    category: "llm" as IntegrationCategory,
    description: "Used by Claude-family chat models. Get a key at console.anthropic.com → API keys.",
    fields: [
      { key: "api_key", label: "API key", placeholder: "sk-ant-…", secret: true, required: true },
    ],
  },
  "claude-code": {
    label: "Claude Code",
    category: "infrastructure" as IntegrationCategory,
    description:
      "Used by the claude_delegate tool to spawn your local Claude Code CLI. " +
      "Store CLI/env overrides here so Jarela doesn't depend on your shell session. " +
      "Supports API key or auth token, optional base URL, and default model overrides.",
    fields: [
      { key: "cli_path", label: "CLI path (optional)", placeholder: "/opt/homebrew/bin/claude", secret: false, required: false },
      { key: "api_key", label: "Anthropic API key (optional)", placeholder: "sk-ant-…", secret: true, required: false },
      { key: "auth_token", label: "Anthropic auth token (optional)", placeholder: "auth_…", secret: true, required: false },
      { key: "base_url", label: "Anthropic base URL (optional)", placeholder: "https://api.anthropic.com", secret: false, required: false },
      { key: "default_opus_model", label: "Default Opus model (optional)", placeholder: "claude-opus-4-1", secret: false, required: false },
      { key: "default_sonnet_model", label: "Default Sonnet model (optional)", placeholder: "claude-sonnet-4-5", secret: false, required: false },
      { key: "default_haiku_model", label: "Default Haiku model (optional)", placeholder: "claude-haiku-4-5", secret: false, required: false },
      { key: "default_model", label: "Default delegate model (optional)", placeholder: "sonnet, opus, haiku, or full model id", secret: false, required: false },
      { key: "default_tools", label: "Default Claude tools (optional)", placeholder: "default or Read,Grep,WebSearch", secret: false, required: false },
      { key: "default_add_dirs", label: "Extra directories (optional)", placeholder: "/path/one, /path/two", secret: false, required: false },
      { key: "default_permission_mode", label: "Permission mode (optional)", placeholder: "dontAsk, default, acceptEdits, bypassPermissions, plan", secret: false, required: false },
      { key: "default_allow_unsafe", label: "Allow unsafe by default (optional)", placeholder: "false", secret: false, required: false },
      { key: "default_background", label: "Run in background by default (optional)", placeholder: "false", secret: false, required: false },
      { key: "default_timeout_seconds", label: "Timeout seconds (optional)", placeholder: "600", secret: false, required: false },
      { key: "default_sync_memory", label: "Memory sync mode (optional)", placeholder: "both, in, out, or false", secret: false, required: false },
      { key: "default_escalate_questions", label: "Ask design questions by default (optional)", placeholder: "true", secret: false, required: false },
    ],
  },
  atlassian: {
    label: "Atlassian (Jira + Confluence)",
    category: "issue-tracker" as IntegrationCategory,
    description: "Used by jira_* and confluence_* tools. Get an API token at id.atlassian.com → Security → API tokens.",
    fields: [
      { key: "url", label: "Site URL", placeholder: "https://your-team.atlassian.net", secret: false, required: true },
      { key: "email", label: "Account email", placeholder: "you@company.com", secret: false, required: true },
      { key: "api_token", label: "API token", placeholder: "ATATT3xFfGF0…", secret: true, required: true },
    ],
  },
  jira_align: {
    label: "Jira Align",
    category: "issue-tracker" as IntegrationCategory,
    description:
      "Used by jira_align_* tools (read/search/walk hierarchy, create/update/transition/delete " +
      "work items, comment). Generate an API token in Jira Align under Settings → Personal " +
      "Access Tokens. Different surface from Jira Cloud — this is the portfolio-level product.",
    fields: [
      { key: "url", label: "Instance URL", placeholder: "https://your-company.jiraalign.com", secret: false, required: true },
      { key: "api_token", label: "API token", placeholder: "eyJ…", secret: true, required: true },
    ],
  },
  google: {
    label: "Google AI (Gemini + Imagen)",
    category: "llm" as IntegrationCategory,
    description:
      "Used by Gemini chat models and the generate_image tool (Imagen). Get a key at " +
      "aistudio.google.com → API keys.",
    fields: [
      { key: "api_key", label: "API key", placeholder: "AIza…", secret: true, required: true },
    ],
  },
  openai: {
    label: "OpenAI",
    category: "llm" as IntegrationCategory,
    description:
      "Used by GPT-family chat and embedding models. Create a key at platform.openai.com → " +
      "API keys. Project-scoped keys (sk-proj-…) work the same as user keys.",
    fields: [
      { key: "api_key", label: "API key", placeholder: "sk-… or sk-proj-…", secret: true, required: true },
    ],
  },
  deepseek: {
    label: "DeepSeek",
    category: "llm" as IntegrationCategory,
    description:
      "Used by deepseek-chat and deepseek-reasoner. Get a key at platform.deepseek.com → " +
      "API keys.",
    fields: [
      { key: "api_key", label: "API key", placeholder: "sk-…", secret: true, required: true },
    ],
  },
  cohere: {
    label: "Cohere",
    category: "llm" as IntegrationCategory,
    description:
      "Used by Cohere command-family chat models and embed-v3 embeddings. Get a key at " +
      "dashboard.cohere.com → API keys.",
    fields: [
      { key: "api_key", label: "API key", placeholder: "co_…", secret: true, required: true },
    ],
  },
  "github-copilot": {
    label: "GitHub Copilot",
    category: "llm" as IntegrationCategory,
    description:
      "Routes chat-completion requests through your Copilot subscription. Paste a GitHub PAT " +
      "with `copilot` scope from github.com/settings/tokens, or run the device-flow sign-in in " +
      "the Models panel.",
    fields: [
      { key: "api_key", label: "GitHub PAT", placeholder: "ghp_… or github_pat_…", secret: true, required: true },
    ],
  },
  gmail: {
    label: "Gmail + Calendar",
    category: "mail" as IntegrationCategory,
    description:
      "Used by the gmail_* and calendar_* tools (search/read/draft/label/archive mail; " +
      "list/create/update/delete calendar events). Drafts only \u2014 this integration " +
      "intentionally cannot send mail. One-click Connect uses the bundled Jarela Google " +
      "client (Desktop type, PKCE-only \u2014 no client secret ships in the binary); " +
      "advanced users can paste their own OAuth client below and Jarela will use that instead.",
    fields: [
      { key: "client_id", label: "OAuth client ID (advanced)", placeholder: "<id>.apps.googleusercontent.com", secret: false, required: false },
      { key: "client_secret", label: "OAuth client secret (advanced)", placeholder: "GOCSPX-\u2026", secret: true, required: false },
      { key: "refresh_token", label: "Refresh token", placeholder: "1//0\u2026", secret: true, required: false },
    ],
  },  github: {
    label: "GitHub",
    category: "infrastructure" as IntegrationCategory,
    description:
      "Used by github_* tools (search/read/create/comment on issues + PRs, list PRs, get repo info). " +
      "Create a Personal Access Token at github.com/settings/tokens. Scopes: `repo` (private repos) or " +
      "`public_repo` (public only); add `read:org` if you target org repos.",
    fields: [
      { key: "token", label: "Personal Access Token", placeholder: "ghp_… or github_pat_…", secret: true, required: true },
    ],
  },
  outlook: {
    label: "Outlook + Calendar + To Do",
    category: "mail" as IntegrationCategory,
    description:
      "Used by the outlook_*, outlook_calendar_*, and ms_todo_* tools (search/read/draft/move/trash mail; " +
      "list/create/update/delete calendar events; manage Microsoft To Do task lists and tasks). " +
      "Drafts only — this integration intentionally cannot send mail. Requires an Azure app " +
      "registration. Existing connections must reconnect to grant the new Tasks scope. See the Setup guide below.",
    fields: [
      { key: "client_id", label: "Application (client) ID", placeholder: "00000000-0000-0000-0000-000000000000", secret: false, required: true },
      { key: "client_secret", label: "Client secret value", placeholder: "abc~…", secret: true, required: true },
      { key: "refresh_token", label: "Refresh token", placeholder: "0.AXoA…", secret: true, required: true },
    ],
  },
  icloud: {
    label: "iCloud Mail + Calendar + Reminders",
    category: "mail" as IntegrationCategory,
    description:
      "Used by the icloud_mail_*, icloud_calendar_*, and icloud_reminders_* tools " +
      "(list/read/draft/move/flag/trash mail; list/create/update/delete calendar events; " +
      "list/create/complete reminders). Drafts only — Jarela intentionally does not send mail. " +
      "Apple does not expose an OAuth REST API for these surfaces, so auth is the Apple ID plus " +
      "an app-specific password generated at appleid.apple.com (requires 2FA on the Apple ID). " +
      "The password is stored encrypted at rest like every other credential.",
    fields: [
      { key: "apple_id", label: "Apple ID", placeholder: "johnappleseed@icloud.com", secret: false, required: true },
      { key: "app_password", label: "App-specific password", placeholder: "xxxx-xxxx-xxxx-xxxx", secret: true, required: true },
    ],
  },
} as const;

export type IntegrationName = keyof typeof INTEGRATIONS;

export function isKnownIntegration(name: string): name is IntegrationName {
  return Object.prototype.hasOwnProperty.call(INTEGRATIONS, name);
}

// ---------------------------------------------------------------------------
// Dynamic integrations — external drop-in providers that declare credentials.
// Populated by lib/providers/provider-integrations.ts on each request to the
// integrations endpoint. Missing row = not registered yet (treated same as
// "not configured" by the UI).
// ---------------------------------------------------------------------------

export interface DynamicIntegrationDef {
  label: string;
  category: IntegrationCategory;
  description: string;
  fields: ReadonlyArray<{ key: string; label: string; placeholder?: string; secret: boolean; required: boolean }>;
}

const DYNAMIC_INTEGRATIONS = new Map<string, DynamicIntegrationDef>();

export function registerDynamicIntegration(name: string, def: DynamicIntegrationDef): void {
  DYNAMIC_INTEGRATIONS.set(name, def);
}

export function clearDynamicIntegrations(): void {
  DYNAMIC_INTEGRATIONS.clear();
}

// True for both static INTEGRATIONS entries AND dynamically-registered
// external provider integrations. Use instead of isKnownIntegration when
// handling requests that may reference either kind.
export function isAnyKnownIntegration(name: string): boolean {
  return isKnownIntegration(name) || DYNAMIC_INTEGRATIONS.has(name);
}

// Returns a snapshot of all dynamic integration entries as an array of
// [name, def] pairs. Used by the integrations list route to include
// drop-in provider definitions alongside static INTEGRATIONS entries.
export function DYNAMIC_INTEGRATIONS_SNAPSHOT(): Array<[string, DynamicIntegrationDef]> {
  return [...DYNAMIC_INTEGRATIONS.entries()];
}

function getAnyIntegrationDef(name: string): DynamicIntegrationDef | undefined {
  if (isKnownIntegration(name)) {
    const s = INTEGRATIONS[name];
    return { label: s.label, category: s.category, description: s.description, fields: s.fields };
  }
  return DYNAMIC_INTEGRATIONS.get(name);
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
  const creds = listCredentials({ type: "integration" });
  // Pick the first credential per provider (sorted by id ascending; the
  // migrated `integration-<name>` always sorts before `integration-<name>-N`).
  const byProvider = new Map<string, ReturnType<typeof getCredential> & {}>();
  for (const c of creds) {
    if (!c) continue;
    if (!byProvider.has(c.provider)) byProvider.set(c.provider, c);
  }
  const allNames = [...Object.keys(INTEGRATIONS), ...DYNAMIC_INTEGRATIONS.keys()];
  return allNames.map((name) => {
    const cred = byProvider.get(name);
    const meta = getIntegrationMeta(name);
    if (!cred) {
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
      values: maskSecrets(name, paramsToStrings(getCredentialParams(cred))),
      updated_at: cred.updated_at,
      source: meta.source,
      rc_synced_at: meta.rc_synced_at,
    };
  });
}

export function getIntegrationStatus(name: string): IntegrationStatus | null {
  if (!isAnyKnownIntegration(name)) return null;
  const cred = firstCredentialFor(name);
  const meta = getIntegrationMeta(name);
  if (!cred) {
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
    values: maskSecrets(name, paramsToStrings(getCredentialParams(cred))),
    updated_at: cred.updated_at,
    source: meta.source,
    rc_synced_at: meta.rc_synced_at,
  };
}

// Internal: server-side resolution that returns RAW secrets. Only callable
// from server code (the integration tools).
//
// Resolution order:
//   1. If an active tool-credential context is bound (i.e. the call is
//      coming from inside a wrapped tool invocation) and the agent has
//      pinned a specific credential id for THIS tool name, load that id.
//      The id must match the integration's provider — otherwise we ignore
//      the override to avoid silently grabbing the wrong account's secrets.
//   2. Otherwise fall back to the integration's default credential
//      (`is_default = 1`), matching legacy single-instance behaviour.
export function getIntegrationRaw(name: string): Record<string, string> | null {
  const cred = resolveIntegrationCredential(name);
  if (!cred) return null;
  return paramsToStrings(getCredentialParams(cred));
}

// Resolve a specific credential by id (any provider). Returns null when the
// id is unknown or carries no params. Used by callers that already know
// which named credential to bind — e.g. a document-RAG indexer that was
// configured with `credential_id="integration-gmail-personal"`.
export function getIntegrationRawById(credentialId: string): Record<string, string> | null {
  const cred = getCredential(credentialId);
  if (!cred) return null;
  return paramsToStrings(getCredentialParams(cred));
}

function resolveIntegrationCredential(name: string) {
  if (!isAnyKnownIntegration(name)) return null;
  const ctx = getCurrentToolCredentialContext();
  if (ctx) {
    const overrideId = ctx.toolCredentials[ctx.toolName];
    if (overrideId) {
      const override = getCredential(overrideId);
      if (override && override.type === "integration" && override.provider === name) {
        return override;
      }
      // Mismatched override (wrong provider, deleted id, …) silently falls
      // through to the default. The agent editor shouldn't allow saving
      // these, but a stale row from before a credential was deleted is
      // still possible.
    }
  }
  return getDefaultCredential("integration", name);
}

// Save credentials. Any field whose value matches SECRET_MASK is preserved
// from the existing record (so unchanged secret fields don't get blanked
// when the UI sends back the masked form).
export function saveIntegration(name: string, incoming: Record<string, string>): IntegrationStatus | { error: string } {
  if (!isAnyKnownIntegration(name)) return { error: `unknown integration "${name}"` };
  const def = getAnyIntegrationDef(name)!;
  const existingCred = firstCredentialFor(name);
  const existing = existingCred ? paramsToStrings(getCredentialParams(existingCred)) : {};
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
  if (Object.keys(merged).length === 0) {
    return { error: `add at least one field for "${def.label}" or clear the integration instead` };
  }
  const auth_method = deriveAuthMethod(name);
  if (existingCred) {
    updateCredential(existingCred.id, { auth_method, params: merged });
  } else {
    createCredential({
      id: `integration-${name}`,
      type: "integration",
      provider: name,
      auth_method,
      params: merged,
    });
  }
  // Drop the legacy plaintext row if it's still lingering from before
  // the credentials migration.
  deleteMemory(LEGACY_NAMESPACE, name);
  if (touched.length > 0) markFieldsAsUserTouched(name, touched);
  return getIntegrationStatus(name)!;
}

export function deleteIntegration(name: string): boolean {
  if (!isAnyKnownIntegration(name)) return false;
  // Delete every credential for this provider (covers multi-instance
  // future-state — the user clicking "Disconnect" on the integrations
  // panel still expects all of them gone).
  const creds = listCredentials({ type: "integration", provider: name });
  let removed = false;
  for (const c of creds) {
    if (deleteCredential(c.id)) removed = true;
  }
  // Sweep any legacy plaintext row too.
  if (deleteMemory(LEGACY_NAMESPACE, name)) removed = true;
  return removed;
}

function firstCredentialFor(name: string) {
  // "First" historically meant lowest-id; today it means the row currently
  // flagged as default for this provider. The two coincide for legacy
  // single-instance installs because the migration promoted MIN(id) to
  // default.
  return getDefaultCredential("integration", name);
}

function deriveAuthMethod(name: string): "api_key" | "oauth" {
  const def = getAnyIntegrationDef(name);
  if (!def) return "api_key";
  const keys = new Set(def.fields.map((f) => f.key));
  return keys.has("client_id") && keys.has("client_secret") ? "oauth" : "api_key";
}

function paramsToStrings(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function maskSecrets(name: string, values: Record<string, string>): Record<string, string> {
  const def = getAnyIntegrationDef(name);
  if (!def) return {};
  const out: Record<string, string> = {};
  for (const f of def.fields) {
    const v = values[f.key];
    if (v === undefined) continue;
    out[f.key] = f.secret ? SECRET_MASK : v;
  }
  return out;
}
