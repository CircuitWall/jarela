---
status: proposed
date: 2026-05-22
deciders: example-user
consulted:
informed:
---

# Native Jira Align tool (REST, sibling to Atlassian Cloud)

## Context and Problem Statement

Users on enterprise teams want to read and manipulate portfolio-level
work items (epics, capabilities, features, OKRs) directly from Jarela
agents. Jira Align is the Atlassian product that owns this layer — it
is **not** the same surface as Jira Cloud (which `lib/tools/atlassian.ts`
already covers). It has a separate hostname (`<instance>.jiraalign.com`),
a separate auth model (Bearer token, not email + Cloud API token), a
separate REST surface (`/rest/align/api/2/...`), and a separate set of
work-item types and hierarchy semantics.

We need first-class agent tooling for it — without forcing every user to
shell out to a CLI or to maintain a fragile MCP install on a corporate
network.

## Decision Drivers

* **Single-process invariant** — runs in the existing Next.js process,
  no new daemon ([[adr-0011]] holds).
* **Reuse the corporate-proxy path** — the tool's `fetch` calls go
  through the existing undici `EnvHttpProxyAgent`, the same one Atlassian
  Cloud / GitHub / Gmail tools use. No bespoke transport.
* **Per-operation permissions.** Users need to flip read / write / delete
  independently — not all-or-nothing. CRUD as one tool would force
  users to either grant the agent destructive power or block it entirely.
* **Auth lives in two places.** Server-deployed instances want
  env-var config (so creds don't sit in SQLite); per-user installs want
  the in-app Integrations panel. The tool must accept both, env first.
* **Don't pretend to be Jira Cloud.** Sharing a tool name or auth path
  would silently misroute calls. Distinct file, distinct integration
  key, distinct env var prefix.

## Considered Options

* **A — Native REST tool, one tool per CRUD op.** Mirrors the Atlassian
  Cloud and GitHub tools. Each operation (`jira_align_get_item`,
  `…_search_items`, `…_create_item`, `…_update_item`,
  `…_transition_item`, `…_delete_item`, `…_add_comment`,
  `…_get_item_children`) is its own `tool(...)`, registered under a new
  `JiraAlign` category in `Work` group. Permissions are managed via the
  existing AgentEditor checkbox grid + `ToolPolicy.allow/deny`.
* **B — Single `jira_align` mega-tool with an `op` arg.** One tool, JSON
  arg `{op: "get" | "search" | "create" | "update" | …}`. Smaller surface
  for the LLM but no per-op permission gate.
* **C — MCP server.** Run an external MCP process that speaks the JA
  REST API. Reuses LangGUI's MCP plumbing.

## Decision Outcome

Chosen option: **A — native REST, one tool per CRUD op.**

Matches the existing Atlassian/GitHub pattern so the codebase stays
uniform and the AgentEditor "uncheck individual tools" UX works without
extra wiring. The auth resolver is the same idiom users already learned
from `atlassian.ts` (env first, `getIntegrationRaw` fallback). Adding a
new vendor in the same shape costs ~250 lines and zero new
infrastructure.

### Consequences

* **Good** — per-op permission control falls out of the existing tool
  registry. To make the agent read-only, uncheck the four write tools.
  No new policy code.
* **Good** — env-var deploys (`JIRA_ALIGN_URL` / `JIRA_ALIGN_TOKEN`) work
  identically to Atlassian, GitHub, etc.
* **Good** — corporate proxy / NODE_EXTRA_CA_CERTS just work because the
  fetch path is unchanged.
* **Good** — destructive `jira_align_delete_item` requires an explicit
  `confirm` arg matching the item id. Two-arg gate, like the destructive
  shell-exec tool, so a misfired tool call cannot wipe a record.
* **Bad** — Jira Align REST endpoints vary by instance (custom fields,
  workflow names, work-item-type IDs). The v1 tool follows the public
  v2 conventions; production users may need to adjust paths against
  their instance's Swagger.
* **Bad** — no streaming / pagination beyond a single `nextPageToken`.
  Large hierarchy walks are bounded to depth 4 by `…_get_item_children`
  to keep round-trip count predictable.
* **Bad** — adds a third external-API dependency to the "online-required"
  feature surface. This is the trigger that requires this ADR per the
  project's decision rules.

### Why not B (mega-tool)

* `op` arg is opaque to the LLM — it can't tell from the tool description
  which sub-ops are permitted right now.
* AgentEditor would need a parallel sub-op-permission UI — duplicating
  what the per-tool checkbox grid already does.
* Schema validation is harder: each op has a different required-field
  set, and zod discriminated unions are awkward to expose to LangChain's
  `convertToOpenAITool`.

### Why not C (MCP)

* Reintroduces the corporate-network problem `atlassian.ts` was created
  to dodge: `mcp-atlassian`-style installs are fragile when PyPI/npm are
  blocked.
* Adds a new process to manage at the time the user fires the agent.
* Operator-facing logs split between Jarela and the MCP process.

## Auth contract

```
Resolution order:
  1. Env: JIRA_ALIGN_URL, JIRA_ALIGN_TOKEN
  2. Memory store: namespace="integrations", key="jira_align",
     value={ url, api_token }
```

Stored secrets follow the existing `lib/stores/integrations.ts` masking
contract — the UI never sees raw tokens after the initial save.

## Tool surface — v1

| Tool                              | Read | Write | Default in AgentEditor |
|-----------------------------------|:----:|:-----:|:----------------------:|
| `jira_align_get_item`             |  ✓   |       | enabled                |
| `jira_align_search_items`         |  ✓   |       | enabled                |
| `jira_align_get_item_children`    |  ✓   |       | enabled                |
| `jira_align_create_item`          |      |   ✓   | enabled                |
| `jira_align_update_item`          |      |   ✓   | enabled                |
| `jira_align_transition_item`      |      |   ✓   | enabled                |
| `jira_align_add_comment`          |      |   ✓   | enabled                |
| `jira_align_delete_item`          |      |   ✓   | **disabled** (opt-in)  |

Delete is opt-in because Jira Align deletes are not undoable.

## Out of scope

* **Custom-field mapping per instance.** Field names ship raw — the
  agent gets `customField_42` if that's what the API returns. A v2
  could pull the schema endpoint and translate.
* **Bulk import / spreadsheet sync.** One item per call; bulk goes
  through the agent loop.
* **OKRs and value-stream domains beyond `items`.** A separate tool
  family if/when the use case appears.
* **Webhook subscription.** No push from JA → Jarela. Polling via
  `…_search_items?updated_since=…` is the v1 freshness path.
* **Multiple JA instances per Jarela install.** Single instance only;
  a future env-var array or per-agent override would unblock multi.

## More Information

* Tool: `lib/tools/jira-align.ts`.
* Registration: `lib/tools/index.ts` (`JiraAlign` category, `Work` group).
* Integration credentials: `lib/stores/integrations.ts` (`jira_align`).
* Sibling reference: ADR-0007-ish note in [[atlassian.ts]] explaining
  why we hit the REST API directly rather than running the public MCP.
