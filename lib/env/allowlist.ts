// Mapping from "standard" environment variable names to integration store
// fields. Used by the env-sync feature (lib/env/sync.ts) so common
// rc-defined credentials (GITHUB_TOKEN, ATLASSIAN_API_TOKEN, …) populate
// the encrypted DB automatically and survive rotation without the user
// re-typing them in the Integrations panel.
//
// Adding a new mapping is one line. The integration name MUST exist in
// `INTEGRATIONS` (lib/stores/integrations.ts) and the field key MUST
// match — there is a build-time check in scripts/check-env-allowlist.mjs
// that fails the lint step otherwise.

import type { IntegrationName } from "@/lib/stores/integrations";

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
  // GitHub — used by github_* tools (ADR-0015)
  { envVars: ["GITHUB_TOKEN", "GH_TOKEN"], integration: "github", field: "token" },

  // Atlassian — Jira + Confluence
  { envVars: ["ATLASSIAN_URL", "JIRA_URL"], integration: "atlassian", field: "url" },
  { envVars: ["ATLASSIAN_EMAIL", "JIRA_EMAIL"], integration: "atlassian", field: "email" },
  { envVars: ["ATLASSIAN_API_TOKEN", "JIRA_API_TOKEN", "JIRA_TOKEN"], integration: "atlassian", field: "api_token" },

  // Google AI (Gemini / Imagen) — used by generate_image
  { envVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY"], integration: "google", field: "api_key" },
];

/** Flat list of every env var name we look at, dedup'd. */
export function getAllEnvVarNames(): string[] {
  const set = new Set<string>();
  for (const m of ENV_ALLOWLIST) for (const n of m.envVars) set.add(n);
  return [...set];
}
