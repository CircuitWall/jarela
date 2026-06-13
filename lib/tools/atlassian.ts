/**
 * Atlassian tools adapter — declarative spec for
 * `@circuitwall/atlassian-langchain`. All wiring (env / DB credential
 * resolution, capability registration, `_resolveAtlassianAuth` probe) is
 * handled by the generic `registerLangChainPackage` loader.
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
import { registerLangChainPackage } from "./langchain-package";

const { resolveAuth } = registerLangChainPackage<AtlassianAuth>({
  category: "Atlassian",
  tools: {
    read: atlassianReadTools,
    write: atlassianWriteTools,
    execute: atlassianExecuteTools,
  },
  auth: {
    integrationId: "atlassian",
    setAuthResolver,
    resolveAuthFromEnv: resolveAtlassianAuthFromEnv,
    mapStoreFields: (raw) =>
      raw.url && raw.email && raw.api_token
        ? {
            url: raw.url.replace(/\/+$/, ""),
            email: raw.email,
            apiToken: raw.api_token,
          }
        : null,
    notConfiguredError:
      "Atlassian not configured. Open the gear menu → Integrations tab and add your Atlassian site URL, " +
      "email, and API token. (Or set ATLASSIAN_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN env vars.)",
  },
});

// Probe used by the integrations test endpoint.
export const _resolveAtlassianAuth = resolveAuth;

// Re-exports for sibling-module callers (remote document-RAG indexers in
// lib/documents/remote/{jira,confluence}.ts, ADR-0026, and health probes).
export { atlassianFetch as _atlassianFetch };
export type { AtlassianAuth, JiraFieldDef };
