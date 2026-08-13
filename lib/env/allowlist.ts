// Mapping from "standard" environment variable names to integration store
// fields. Used by the env-sync feature (lib/env/sync.ts) so common
// rc-defined credentials (GITHUB_TOKEN, ATLASSIAN_API_TOKEN, …) populate
// the encrypted DB automatically and survive rotation without the user
// re-typing them in the Integrations panel.
//
// `ENV_ALLOWLIST` is the static, code-owned default. Users can extend any
// row's `envVars` list at runtime via the allowlist overrides API
// (`POST /api/v1/env-sync/allowlist`) — see ADR-0034. They cannot point a
// new env var at a *new* (integration, field): the target side is fixed
// here so we never write rc values into a row that has no schema.
//
// Adding a new mapping is one line. The integration name MUST exist in
// `INTEGRATIONS` (lib/stores/integrations.ts) and the field key MUST
// match — there is a build-time check in scripts/check-env-allowlist.mjs
// that fails the lint step otherwise.

import { getMemory, listMemory, putMemory, deleteMemory } from "@/lib/stores/memory";
import { INTEGRATIONS, getIntegrationRaw, isKnownIntegration, type IntegrationName } from "@/lib/stores/integrations";

const OVERRIDES_NS = "env_allowlist_overrides";

export interface EnvFieldMapping {
  /**
   * Env var names in priority order. The first one that is present and
   * non-empty wins. Lets us support both vendor-canonical names and the
   * older aliases users tend to have in their dotfiles.
   */
  envVars: string[];
  integration: IntegrationName;
  field: string;
}

export const ENV_ALLOWLIST: readonly EnvFieldMapping[] = [
  // Anthropic (Claude) — primary LLM provider
  { envVars: ["ANTHROPIC_API_KEY"], integration: "anthropic", field: "api_key" },

  // Claude Code tool runtime defaults
  { envVars: ["ANTHROPIC_AUTH_TOKEN"], integration: "claude-code", field: "auth_token" },
  { envVars: ["ANTHROPIC_BASE_URL"], integration: "claude-code", field: "base_url" },
  { envVars: ["ANTHROPIC_DEFAULT_OPUS_MODEL"], integration: "claude-code", field: "default_opus_model" },
  { envVars: ["ANTHROPIC_DEFAULT_SONNET_MODEL"], integration: "claude-code", field: "default_sonnet_model" },
  { envVars: ["ANTHROPIC_DEFAULT_HAIKU_MODEL"], integration: "claude-code", field: "default_haiku_model" },

  // GitHub — used by github_* tools (ADR-0015)
  { envVars: ["GITHUB_TOKEN", "GH_TOKEN"], integration: "github", field: "token" },

  // Atlassian — Jira + Confluence
  { envVars: ["ATLASSIAN_URL", "JIRA_URL"], integration: "atlassian", field: "url" },
  { envVars: ["ATLASSIAN_EMAIL", "JIRA_EMAIL"], integration: "atlassian", field: "email" },
  { envVars: ["ATLASSIAN_API_TOKEN", "JIRA_API_TOKEN", "JIRA_TOKEN"], integration: "atlassian", field: "api_token" },

  // Google AI (Gemini / Imagen) — used by generate_image
  { envVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY"], integration: "google", field: "api_key" },
];

// ── User overrides ───────────────────────────────────────────────────────────
// Stored as `memory_store` rows in namespace `"env_allowlist_overrides"`.
// Key is `"<integration>:<field>"`, value is `{ envVars: string[] }`. The
// listed names are *additional* aliases — defaults always remain so a
// user who renames their dotfile var doesn't lose the canonical fallback.

const OVERRIDE_KEY = (integration: string, field: string): string => `${integration}:${field}`;

interface StoredOverride { envVars: string[] }

function parseOverride(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as StoredOverride;
    if (parsed && Array.isArray(parsed.envVars)) {
      return parsed.envVars.filter((v) => typeof v === "string" && v.trim().length > 0);
    }
  } catch { /* fall through */ }
  return [];
}

/** Read every (integration, field) override the user has saved. */
export function listOverrides(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of listMemory(OVERRIDES_NS, undefined, 200)) {
    out[row.key] = parseOverride(row.value);
  }
  return out;
}

/** Read one override; returns the empty list when none is stored. */
export function getOverride(integration: string, field: string): string[] {
  const row = getMemory(OVERRIDES_NS, OVERRIDE_KEY(integration, field));
  return row ? parseOverride(row.value) : [];
}

/**
 * Persist an override. Validates that the (integration, field) pair points
 * at an existing schema entry — env-var renames cannot create new targets.
 * Names are uppercased and de-duplicated; defaults are stripped from the
 * stored payload so a future schema change to canonical names doesn't
 * leave dead duplicates behind.
 */
export function setOverride(integration: string, field: string, envVars: string[]):
  | { ok: true; envVars: string[] }
  | { ok: false; error: string }
{
  if (!isKnownIntegration(integration)) {
    return { ok: false, error: `unknown integration "${integration}"` };
  }
  const def = INTEGRATIONS[integration];
  if (!def.fields.some((f) => f.key === field)) {
    return { ok: false, error: `unknown field "${field}" on integration "${integration}"` };
  }
  const defaults = defaultAliasesFor(integration, field);
  const cleaned: string[] = [];
  const seen = new Set<string>(defaults);
  for (const raw of envVars) {
    if (typeof raw !== "string") continue;
    const name = raw.trim().toUpperCase();
    if (!name) continue;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      return { ok: false, error: `"${raw}" is not a valid env var name` };
    }
    if (seen.has(name)) continue;
    seen.add(name);
    cleaned.push(name);
  }
  if (cleaned.length === 0) {
    deleteMemory(OVERRIDES_NS, OVERRIDE_KEY(integration, field));
    return { ok: true, envVars: [] };
  }
  putMemory(OVERRIDES_NS, OVERRIDE_KEY(integration, field), { envVars: cleaned } satisfies StoredOverride);
  return { ok: true, envVars: cleaned };
}

/** Drop the override row for one (integration, field). */
export function deleteOverride(integration: string, field: string): boolean {
  return deleteMemory(OVERRIDES_NS, OVERRIDE_KEY(integration, field));
}

function defaultAliasesFor(integration: string, field: string): string[] {
  const m = ENV_ALLOWLIST.find((m) => m.integration === integration && m.field === field);
  return m ? [...m.envVars] : [];
}

// ── Effective allowlist ──────────────────────────────────────────────────────

/**
 * `ENV_ALLOWLIST` merged with stored overrides. Default aliases come first
 * so they keep their priority during sync; user-added aliases are appended
 * after them. The shape is identical to `ENV_ALLOWLIST` so call sites can
 * iterate either one — only `runSync` and `getAllEnvVarNames` need the
 * effective view today.
 */
export function getEffectiveAllowlist(): EnvFieldMapping[] {
  const overrides = listOverrides();
  return ENV_ALLOWLIST.map((m) => {
    const extra = overrides[OVERRIDE_KEY(m.integration, m.field)] ?? [];
    if (extra.length === 0) return { ...m, envVars: [...m.envVars] };
    const merged = [...m.envVars];
    const seen = new Set(merged);
    for (const name of extra) {
      if (!seen.has(name)) {
        merged.push(name);
        seen.add(name);
      }
    }
    return { ...m, envVars: merged };
  });
}

/** Flat list of every env var name we look at — defaults + user overrides. */
export function getAllEnvVarNames(): string[] {
  const set = new Set<string>();
  for (const m of getEffectiveAllowlist()) for (const n of m.envVars) set.add(n);
  return [...set];
}

/**
 * Render the encrypted integration store back into a `Record<envVarName, value>`
 * so subprocesses (MCP children, `local_exec` shells) can read credentials
 * even when they were never exported in the launching shell — e.g. when
 * Jarela is installed as a service. For each `(integration, field)` row in
 * the effective allowlist that has a stored value, every alias name (default
 * + user-added override) is set to that value. The first alias to be
 * inserted wins if two different rows would somehow collide.
 */
export function getInjectedSubprocessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of getEffectiveAllowlist()) {
    const value = getIntegrationRaw(m.integration)?.[m.field];
    if (!value) continue;
    for (const name of m.envVars) {
      if (!(name in out)) out[name] = value;
    }
  }
  return out;
}
