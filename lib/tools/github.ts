/**
 * GitHub tools adapter — declarative spec for
 * `@circuitwall/github-langchain`. All wiring (env / DB credential
 * resolution, capability registration, `_resolveGithubAuth` probe) is
 * handled by the generic `registerLangChainPackage` loader.
 */
import {
  setAuthResolver,
  resolveGithubAuthFromEnv,
  githubFetch,
  githubReadTools,
  githubWriteTools,
  githubExecuteTools,
  type GitHubAuth,
} from "@circuitwall/github-langchain";
import { registerLangChainPackage } from "./langchain-package";

const { resolveAuth } = registerLangChainPackage<GitHubAuth>({
  category: "GitHub",
  tools: {
    read: githubReadTools,
    write: githubWriteTools,
    // merge_pull is execute: it triggers CI, deploys, and downstream automation.
    execute: githubExecuteTools,
  },
  auth: {
    integrationId: "github",
    setAuthResolver,
    resolveAuthFromEnv: resolveGithubAuthFromEnv,
    mapStoreFields: (raw) => (raw.token ? { token: raw.token } : null),
    notConfiguredError:
      "GitHub not configured. Open the gear menu → Integrations and add a Personal Access Token. " +
      "Create one at github.com/settings/tokens with scopes: repo, read:org. " +
      "(Or set GITHUB_TOKEN / GH_TOKEN as an env var.)",
  },
});

// Probe used by the integrations test endpoint.
export const _resolveGithubAuth = resolveAuth;

// Re-export for sibling-module callers (remote document-RAG indexer in
// lib/documents/remote/github.ts, ADR-0029).
export { githubFetch as _ghFetch };
export type { GitHubAuth };
