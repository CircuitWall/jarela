/**
 * Atlassian tools adapter — wires `@circuitwall/atlassian-langchain` into
 * Jarela's tool registry and resolves credentials from Jarela's encrypted
 * integrations store (with env-var override).
 *
 * The actual tool implementations live in the published package; this file
 * just adds Jarela-specific glue (auth-from-DB, registry registration, and
 * a `_resolveAtlassianAuth` probe used by the integrations test endpoint).
 */
import {
  setAuthResolver,
  resolveAtlassianAuthFromEnv,
  atlassianFetch,
  atlassianReadTools,
  atlassianWriteTools,
  atlassianExecuteTools,
  type AtlassianAuth,
  type JiraFieldDef,
} from "@circuitwall/atlassian-langchain";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { registerTools } from "./registry";

function resolveAuth(): AtlassianAuth | { error: string } {
  // Env first — deployment-level config wins over per-user secrets in DB.
  const fromEnv = resolveAtlassianAuthFromEnv();
  if ("url" in fromEnv) return fromEnv;
  // Saved integration creds (from the Integrations panel in the UI).
  const saved = getIntegrationRaw("atlassian");
  if (saved?.url && saved.email && saved.api_token) {
    return {
      url: saved.url.replace(/\/+$/, ""),
      email: saved.email,
      apiToken: saved.api_token,
    };
  }
  return {
    error:
      "Atlassian not configured. Open the gear menu → Integrations tab and add your Atlassian site URL, " +
      "email, and API token. (Or set ATLASSIAN_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN env vars.)",
  };
}

setAuthResolver(resolveAuth);

// Exposed so the integrations test endpoint can probe the live API after save.
export function _resolveAtlassianAuth(): AtlassianAuth | { error: string } {
  return resolveAuth();
}

// Re-exports for sibling-module callers (remote document-RAG indexers in
// lib/documents/remote/{jira,confluence}.ts, ADR-0026, and health probes).
export { atlassianFetch as _atlassianFetch };
export type { AtlassianAuth, JiraFieldDef };

registerTools("Atlassian", "read", [...atlassianReadTools]);
registerTools("Atlassian", "write", [...atlassianWriteTools]);
registerTools("Atlassian", "execute", [...atlassianExecuteTools]);
