---
status: accepted
date: 2026-05-20
deciders: andwu
consulted:
informed:
---

# Native GitHub tools via direct REST

## Context and Problem Statement

The agent had no first-party way to read or write GitHub issues and pull requests. Users could install the GitHub MCP server through the picker (ADR-0014), but on the corporate networks where Jarela spends most of its life the MCP install path is regularly blocked — the registry, npm, and GitHub Container Registry are all popular block targets — and even when it works, install/restart adds friction for what is otherwise a simple authenticated REST surface.

ADR-0010 (agent-led setup) and the existing Atlassian native tool ([lib/tools/atlassian.ts](../../lib/tools/atlassian.ts)) already solve this exact problem for Jira/Confluence. Should GitHub follow the same path, or stay MCP-only?

## Decision Drivers

* Work on locked-down corporate networks where MCP installs are blocked but `https://api.github.com` is reachable.
* Match the precedent set by ADR-0010 + the Atlassian tool — auth flows through the Integrations panel, no extra runtime deps, the same proxy / CA bundle plumbing as everything else.
* Honour CLAUDE.md invariants: no new daemon, no required cloud calls, no telemetry. The tool only fires when the agent invokes it.
* Keep the agent steerable away from `local_exec`-ing the `gh` CLI (which would need its own auth, isn't always installed, and can't see env credentials reliably under launchd).

## Considered Options

* **Native REST tools** — ship `lib/tools/github.ts` with a small set of issue/PR tools modeled on `atlassian.ts`. Auth: PAT from env or Integrations store.
* **MCP-only** — rely on the user installing the GitHub MCP server through the picker (ADR-0014).
* **Shell out to `gh` CLI** — provide a thin wrapper around `gh issue list`, `gh pr view`, etc.

## Decision Outcome

Chosen option: **Native REST tools**, alongside (not replacing) the optional MCP path. This is the smallest change that gives every install a working GitHub surface, regardless of network policy or whether `gh` is on PATH.

Initial surface (7 tools): `github_search_issues`, `github_get_issue`, `github_create_issue`, `github_add_comment`, `github_list_pulls`, `github_get_pull`, `github_get_repo`. Auth: `GITHUB_TOKEN` or `GH_TOKEN` env, falling back to the Integrations panel record.

### Consequences

* **Good** — Works on corp networks where MCP installs fail. No new runtime dependencies. Reuses the existing proxy + CA bundle plumbing (ADR-0009, ADR-0012).
* **Good** — The gear-menu Integrations panel handles credential entry + a real `GET /user` smoke test, matching the UX pattern users already know from Atlassian/Gmail/Outlook.
* **Good** — The tool descriptions explicitly steer the agent away from `local_exec`-ing `gh`, mirroring the "PREFER THIS over shell-exec'ing the jira CLI" pattern from `atlassian.ts`.
* **Bad** — We own a small piece of API translation; if GitHub renames a field on `/issues` or `/pulls`, we ship a fix. Acceptable: the v3 REST surface has been stable for years, and the response shapes we project are conservative.
* **Bad** — Two GitHub paths now exist (native + MCP). Users picking the MCP server still works; the native tools quietly become the primary path.

## Pros and Cons of the Options

### Native REST tools

* Good, because it works the moment a PAT is provided — no installs, no daemon, no `gh` binary.
* Good, because credentials live where every other integration credential lives (encrypted at rest under `JARELA_DB_DIR`).
* Neutral, because it's another file with seven small tool definitions to maintain.
* Bad, because we re-implement a slice of what GitHub MCP already does.

### MCP-only

* Good, because zero code in this repo to maintain.
* Bad, because it doesn't work when the network blocks the MCP install path — which is the common case for the audience that needs this most.

### Shell out to `gh` CLI

* Good, because `gh` covers the full GitHub surface.
* Bad, because `gh` isn't always installed, has its own auth (keychain) that the launchd-spawned process may not see, and shell-exec'd output is harder to schema-validate.

## More Information

* Builds on [ADR-0010 — agent-led setup and integration manifests](0010-agent-led-setup-and-integration-manifests.md).
* Mirrors the Atlassian native-tool pattern at [lib/tools/atlassian.ts](../../lib/tools/atlassian.ts).
* Coexists with the MCP path defined by [ADR-0014 — MCP registry online discovery](0014-mcp-registry-online-discovery.md).
* Out of scope, deferred to follow-up ADRs if needed: file contents API, workflow runs, releases, GitHub App installation tokens, inbound webhooks (the latter would break the single-process invariant).
