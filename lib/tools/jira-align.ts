/**
 * Jira Align tools adapter — wires `@circuitwall/jira-align-langchain` into
 * Jarela's tool registry and resolves credentials from Jarela's encrypted
 * integrations store (with env-var override).
 *
 * The actual tool implementations live in the published package; this file
 * just adds Jarela-specific glue (auth-from-DB, registry registration, and
 * a `_resolveJiraAlignAuth` probe used by the integrations test endpoint).
 */
import {
  setAuthResolver,
  resolveJiraAlignAuthFromEnv,
  jiraAlignFetch,
  jiraAlignReadTools,
  jiraAlignWriteTools,
  jiraAlignExecuteTools,
  type JiraAlignAuth,
} from "@circuitwall/jira-align-langchain";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { registerTools } from "./registry";

function resolveAuth(): JiraAlignAuth | { error: string } {
  // Env first — deployment-level config wins over per-user secrets in DB.
  const fromEnv = resolveJiraAlignAuthFromEnv();
  if ("url" in fromEnv) return fromEnv;
  // Saved integration creds (from the Integrations panel in the UI).
  const saved = getIntegrationRaw("jira_align");
  if (saved?.url && saved.api_token) {
    return {
      url: saved.url.replace(/\/+$/, ""),
      apiToken: saved.api_token,
    };
  }
  return {
    error:
      "Jira Align not configured. Open the gear menu → Integrations tab and add your " +
      "Jira Align instance URL and API token. (Or set JIRA_ALIGN_URL / JIRA_ALIGN_TOKEN " +
      "env vars before starting Jarela.)",
  };
}

setAuthResolver(resolveAuth);

// Exposed so the integrations test endpoint can probe the live API after save.
export function _resolveJiraAlignAuth(): JiraAlignAuth | { error: string } {
  return resolveAuth();
}

export { jiraAlignFetch as _jiraAlignFetch };
export type { JiraAlignAuth };

registerTools("JiraAlign", "read", [...jiraAlignReadTools]);
registerTools("JiraAlign", "write", [...jiraAlignWriteTools]);
registerTools("JiraAlign", "execute", [...jiraAlignExecuteTools]);
