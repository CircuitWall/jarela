/**
 * Built-in LangChain package wiring.
 *
 * Replaces the per-package adapter files (atlassian.ts, github.ts,
 * jira-align.ts) with a single declarative table. Each entry calls the
 * generic `registerLangChainPackage` loader and exposes its
 * `resolveAuth` under an integration id so health probes and
 * cross-module callers (lib/documents/remote/*) can look it up via
 * `resolvePackageAuth` without importing the wiring file directly.
 *
 * The hot-load manifest loader (lib/tools/langchain-packages.ts) is for
 * operator-installed packages; this file is the same machinery applied
 * statically at process boot so the in-tree integrations behave
 * identically to anything an operator installs later.
 */
import {
  atlassianReadTools,
  atlassianWriteTools,
  atlassianExecuteTools,
  setAuthResolver as setAtlassianAuthResolver,
  resolveAtlassianAuthFromEnv,
  type AtlassianAuth,
} from "@circuitwall/atlassian-langchain";
import {
  githubReadTools,
  githubWriteTools,
  githubExecuteTools,
  setAuthResolver as setGithubAuthResolver,
  resolveGithubAuthFromEnv,
  type GitHubAuth,
} from "@circuitwall/github-langchain";
import {
  jiraAlignReadTools,
  jiraAlignWriteTools,
  jiraAlignExecuteTools,
  setAuthResolver as setJiraAlignAuthResolver,
  resolveJiraAlignAuthFromEnv,
  type JiraAlignAuth,
} from "@circuitwall/jira-align-langchain";

import { registerLangChainPackage } from "./langchain-package";
import { setPackageAuthResolver } from "./auth-registry";

// ── Atlassian ───────────────────────────────────────────────────────────────
const atlassian = registerLangChainPackage<AtlassianAuth>({
  category: "Atlassian",
  tools: {
    read: atlassianReadTools,
    write: atlassianWriteTools,
    execute: atlassianExecuteTools,
  },
  auth: {
    integrationId: "atlassian",
    setAuthResolver: setAtlassianAuthResolver,
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
setPackageAuthResolver<AtlassianAuth>("atlassian", atlassian.resolveAuth);

// ── GitHub ──────────────────────────────────────────────────────────────────
const github = registerLangChainPackage<GitHubAuth>({
  category: "GitHub",
  tools: {
    read: githubReadTools,
    write: githubWriteTools,
    // merge_pull is execute: it triggers CI, deploys, and downstream automation.
    execute: githubExecuteTools,
  },
  auth: {
    integrationId: "github",
    setAuthResolver: setGithubAuthResolver,
    resolveAuthFromEnv: resolveGithubAuthFromEnv,
    mapStoreFields: (raw) => (raw.token ? { token: raw.token } : null),
    notConfiguredError:
      "GitHub not configured. Open the gear menu → Integrations and add a Personal Access Token. " +
      "Create one at github.com/settings/tokens with scopes: repo, read:org. " +
      "(Or set GITHUB_TOKEN / GH_TOKEN as an env var.)",
  },
});
setPackageAuthResolver<GitHubAuth>("github", github.resolveAuth);

// ── Jira Align ──────────────────────────────────────────────────────────────
const jiraAlign = registerLangChainPackage<JiraAlignAuth>({
  category: "JiraAlign",
  tools: {
    read: jiraAlignReadTools,
    write: jiraAlignWriteTools,
    execute: jiraAlignExecuteTools,
  },
  auth: {
    integrationId: "jira_align",
    setAuthResolver: setJiraAlignAuthResolver,
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
setPackageAuthResolver<JiraAlignAuth>("jira_align", jiraAlign.resolveAuth);
