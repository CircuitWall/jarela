import type { StructuredToolInterface } from "@langchain/core/tools";
import { optionalFunction, optionalTools } from "../optional-package";
import { registerLangChainPackage } from "../langchain-package";
import type { DefaultPackageDescriptor } from "./types";

const read = optionalTools<StructuredToolInterface>("@circuitwall/jira-align-langchain", "jiraAlignReadTools");
const write = optionalTools<StructuredToolInterface>("@circuitwall/jira-align-langchain", "jiraAlignWriteTools");
const execute = optionalTools<StructuredToolInterface>("@circuitwall/jira-align-langchain", "jiraAlignExecuteTools");
const setAuthResolver = optionalFunction("@circuitwall/jira-align-langchain", "setAuthResolver", () => undefined);
const resolveAuthFromEnv = optionalFunction("@circuitwall/jira-align-langchain", "resolveJiraAlignAuthFromEnv", () => ({ error: "Jira Align package is not installed." }));

export const jiraAlignDefaultPackage: DefaultPackageDescriptor = {
  id: "jira_align",
  label: "Jira Align",
  category: "JiraAlign",
  integrationId: "jira_align",
  npmPackage: "@circuitwall/jira-align-langchain",
  toolCounts: { read: read.length, write: write.length, execute: execute.length },
  description: "Jira Align portfolio-level reads/writes for roadmaps and initiatives.",
  register: () => registerLangChainPackage({
    category: "JiraAlign",
    tools: { read, write, execute },
    auth: {
      integrationId: "jira_align",
      setAuthResolver,
      resolveAuthFromEnv,
      mapStoreFields: (raw) => raw.url && raw.api_token
        ? { url: raw.url.replace(/\/+$/, ""), apiToken: raw.api_token }
        : null,
      notConfiguredError:
        "Jira Align not configured. Open Settings → Credentials and add your Jira Align " +
        "instance URL and API token. (Or set JIRA_ALIGN_URL / JIRA_ALIGN_TOKEN env vars.)",
    },
  }),
};