/**
 * Jira Align tools adapter — declarative spec for
 * `@circuitwall/jira-align-langchain`. All wiring (env / DB credential
 * resolution, capability registration, `_resolveJiraAlignAuth` probe) is
 * handled by the generic `registerLangChainPackage` loader.
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
import { registerLangChainPackage } from "./langchain-package";

const { resolveAuth } = registerLangChainPackage<JiraAlignAuth>({
  category: "JiraAlign",
  tools: {
    read: jiraAlignReadTools,
    write: jiraAlignWriteTools,
    execute: jiraAlignExecuteTools,
  },
  auth: {
    integrationId: "jira_align",
    setAuthResolver,
    resolveAuthFromEnv: resolveJiraAlignAuthFromEnv,
    mapStoreFields: (raw) =>
      raw.url && raw.api_token
        ? {
            url: raw.url.replace(/\/+$/, ""),
            apiToken: raw.api_token,
          }
        : null,
    notConfiguredError:
      "Jira Align not configured. Open the gear menu → Integrations tab and add your " +
      "Jira Align instance URL and API token. (Or set JIRA_ALIGN_URL / JIRA_ALIGN_TOKEN " +
      "env vars before starting Jarela.)",
  },
});

// Probe used by the integrations test endpoint.
export const _resolveJiraAlignAuth = resolveAuth;

export { jiraAlignFetch as _jiraAlignFetch };
export type { JiraAlignAuth };
