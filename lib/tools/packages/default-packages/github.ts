import type { StructuredToolInterface } from "@langchain/core/tools";
import { optionalFunction, optionalTools } from "../optional-package";
import { registerLangChainPackage } from "../langchain-package";
import type { DefaultPackageDescriptor } from "./types";

const read = optionalTools<StructuredToolInterface>("@circuitwall/github-langchain", "githubReadTools");
const write = optionalTools<StructuredToolInterface>("@circuitwall/github-langchain", "githubWriteTools");
const execute = optionalTools<StructuredToolInterface>("@circuitwall/github-langchain", "githubExecuteTools");
const setAuthResolver = optionalFunction("@circuitwall/github-langchain", "setAuthResolver", () => undefined);
const resolveAuthFromEnv = optionalFunction("@circuitwall/github-langchain", "resolveGithubAuthFromEnv", () => ({ error: "GitHub package is not installed." }));

export const githubDefaultPackage: DefaultPackageDescriptor = {
  id: "github",
  label: "GitHub",
  category: "GitHub",
  integrationId: "github",
  npmPackage: "@circuitwall/github-langchain",
  toolCounts: { read: read.length, write: write.length, execute: execute.length },
  description: "Issues, pull requests, commits, code search via the GitHub REST API.",
  register: () => registerLangChainPackage({
    category: "GitHub",
    tools: { read, write, execute },
    auth: {
      integrationId: "github",
      setAuthResolver,
      resolveAuthFromEnv,
      mapStoreFields: (raw) => raw.token ? { token: raw.token } : null,
      notConfiguredError:
        "GitHub not configured. Open Settings → Credentials and add a Personal Access Token. " +
        "Create one at github.com/settings/tokens with scopes: repo, read:org. " +
        "(Or set GITHUB_TOKEN / GH_TOKEN as an env var.)",
    },
  }),
};