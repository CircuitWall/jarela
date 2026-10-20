import type { StructuredToolInterface } from "@langchain/core/tools";
import { optionalFunction, optionalTools } from "../optional-package";
import { registerLangChainPackage } from "../langchain-package";
import type { DefaultPackageDescriptor } from "./types";

const read = optionalTools<StructuredToolInterface>("@circuitwall/atlassian-langchain", "atlassianReadTools");
const write = optionalTools<StructuredToolInterface>("@circuitwall/atlassian-langchain", "atlassianWriteTools");
const execute = optionalTools<StructuredToolInterface>("@circuitwall/atlassian-langchain", "atlassianExecuteTools");
const setAuthResolver = optionalFunction("@circuitwall/atlassian-langchain", "setAuthResolver", () => undefined);
const resolveAuthFromEnv = optionalFunction("@circuitwall/atlassian-langchain", "resolveAtlassianAuthFromEnv", () => ({ error: "Atlassian package is not installed." }));

export const atlassianDefaultPackage: DefaultPackageDescriptor = {
  id: "atlassian",
  label: "Atlassian",
  category: "Atlassian",
  integrationId: "atlassian",
  npmPackage: "@circuitwall/atlassian-langchain",
  toolCounts: { read: read.length, write: write.length, execute: execute.length },
  description: "Jira issues + Confluence pages: search, read, comment, update.",
  register: () => registerLangChainPackage({
    category: "Atlassian",
    tools: { read, write, execute },
    auth: {
      integrationId: "atlassian",
      setAuthResolver,
      resolveAuthFromEnv,
      mapStoreFields: (raw) => raw.url && raw.email && raw.api_token
        ? {
            url: raw.url.replace(/\/+$/, ""),
            email: raw.email,
            apiToken: raw.api_token,
            ...(raw.cloud_id ? { cloudId: raw.cloud_id } : {}),
          }
        : null,
      notConfiguredError:
        "Atlassian not configured. Open Settings → Credentials and add your Atlassian site URL, " +
        "email, and API token. Scoped API tokens also need the Cloud ID. " +
        "(Or set ATLASSIAN_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN and optional ATLASSIAN_CLOUD_ID env vars.)",
    },
  }),
};