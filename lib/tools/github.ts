/**
 * GitHub tools adapter — wires `@circuitwall/github-langchain` into Jarela's
 * tool registry and resolves credentials from Jarela's encrypted integrations
 * store (with env-var override).
 *
 * The actual tool implementations live in the published package; this file
 * just adds Jarela-specific glue (auth-from-DB, registry registration, and
 * a `_resolveGithubAuth` probe used by the integrations test endpoint).
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
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { registerTools } from "./registry";

function resolveAuth(): GitHubAuth | { error: string } {
  // Env first — deployment-level config wins over per-user secrets in DB.
  const fromEnv = resolveGithubAuthFromEnv();
  if ("token" in fromEnv) return fromEnv;
  const saved = getIntegrationRaw("github");
  if (saved?.token) return { token: saved.token };
  return {
    error:
      "GitHub not configured. Open the gear menu → Integrations and add a Personal Access Token. " +
      "Create one at github.com/settings/tokens with scopes: repo, read:org. " +
      "(Or set GITHUB_TOKEN / GH_TOKEN as an env var.)",
  };
}

setAuthResolver(resolveAuth);

// Exposed so the integrations test endpoint can probe the live API after save.
export function _resolveGithubAuth(): GitHubAuth | { error: string } {
  return resolveAuth();
}

// Re-export for sibling-module callers (remote document-RAG indexer in
// lib/documents/remote/github.ts, ADR-0029).
export { githubFetch as _ghFetch };
export type { GitHubAuth };

// Re-export the tools + pure helpers so the existing test file
// (`lib/tools/github.test.ts`) and other internal consumers keep working.
export {
  truncate,
  decodeContentsBlob,
  githubSearchIssuesTool,
  githubGetIssueTool,
  githubListIssueCommentsTool,
  githubCreateIssueTool,
  githubUpdateIssueTool,
  githubAddCommentTool,
  githubListPullsTool,
  githubGetPullTool,
  githubListPullFilesTool,
  githubListPullReviewsTool,
  githubCreatePullTool,
  githubUpdatePullTool,
  githubMergePullTool,
  githubRequestReviewersTool,
  githubCreateReviewTool,
  githubGetRepoTool,
  githubListBranchesTool,
  githubGetFileTool,
  githubSearchCodeTool,
} from "@circuitwall/github-langchain";

registerTools("GitHub", "read", [...githubReadTools]);
registerTools("GitHub", "write", [...githubWriteTools]);
// merge_pull is execute: it triggers CI, deploys, and downstream automation.
registerTools("GitHub", "execute", [...githubExecuteTools]);
