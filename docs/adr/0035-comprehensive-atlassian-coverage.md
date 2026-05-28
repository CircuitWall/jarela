---
status: "accepted"
date: 2026-05-28
deciders: andwu
---

# ADR-0035: Comprehensive Atlassian + Jira Align tool coverage

## Context and Problem Statement

The native Atlassian tool surface in
[lib/tools/atlassian.ts](../../lib/tools/atlassian.ts) and the Jira Align
surface in [lib/tools/jira-align.ts](../../lib/tools/jira-align.ts) cover
single-issue/page CRUD well but leave large practical gaps. In particular
the agent has **zero coverage of Jira's Agile API** — it cannot operate
sprints (create, start, complete, move issues, rank backlog) the way it
operates issues today. Several other gaps surface from the same audit:

- Pagination beyond the embedded ~50 comments on an issue.
- Worklogs (read + add).
- Attachment download (bytes) and delete.
- Issue history / changelog.
- Project metadata: list projects / versions / components / issue-types
  / priorities / statuses, plus the version-release lifecycle.
- Confluence v2 holes left from
  [ADR-0026](0026-remote-document-sources.md) /
  [the v2 migration audit](../../lib/tools/atlassian.ts#L962): page
  delete, footer **and inline** comment update/delete, label remove,
  attachment delete.
- Jira Align hierarchy listing: programs / teams / releases / sprints /
  portfolios / value streams. The agent already has work-item CRUD
  ([ADR-0019](0019-jira-align-tool.md), updated by
  [ADR-0021](0021-jira-align-type-aware-routing.md)) but cannot resolve
  human names → ids without a manual round-trip outside the agent.

The user wants the agent to be a useful collaborator on day-to-day Jira
operations (running stand-ups, grooming the backlog, reviewing PI
demos), not just an issue editor.

## Decision Drivers

- **Native over MCP**, per
  [`atlassian.ts` module header](../../lib/tools/atlassian.ts#L1-L17):
  corporate networks block public PyPI/npm, so the `mcp-atlassian`
  install path is fragile. Native REST tools go through the same
  proxy plumbing as the rest of the server.
- **Single PR, single ADR**: the user asked for one bundled change. The
  scope is large but the patterns are uniform — we benefit from the
  reduced review overhead more than we'd benefit from incremental
  shipping.
- **Reuse existing patterns**, not invent new ones: tool registration
  ([lib/tools/registry.ts](../../lib/tools/registry.ts)), auth
  resolution, `omit-arg-to-list-options` for transitions, two-arg
  destructive-confirm gates ([ADR-0021](0021-jira-align-type-aware-routing.md)).
- **Per-tool permissions** continue to work via the AgentEditor
  ([ADR-0033](0033-configurable-harness.md) /
  [lib/agents/base.ts](../../lib/agents/base.ts)) — disable
  `jira_delete_sprint` to take destructive sprint ops away from the
  agent without touching the rest.
- **Coverage**: tighten the gate so the new tool code is actually
  measured. Today `lib/tools/**` is excluded entirely
  ([vitest.config.ts:31](../../vitest.config.ts#L31)).

## Considered Options

1. **Native expansion in atlassian.ts + jira-align.ts (this ADR).**
   ~33 new tools spread across five logical groups (Jira agile, Jira
   issue gaps, Jira project metadata, Confluence gaps, JA hierarchy).
   Reuses `atlassianFetch` / `jaFetch` / `textToADF` / `simplifyADF` /
   `loadJiraFields` / `parseV2NextCursor`. New patterns: a sprint
   state-machine validator, a `kind: footer | inline` router for
   v2 comment edit/delete, and an `ENTITY_TO_COLLECTION` map for JA
   non-work-item collections (mirrors `TYPE_TO_COLLECTION`).
2. **Lean on `mcp-atlassian` for the gaps.**
   We already have the MCP adapter
   ([@langchain/mcp-adapters](../../package.json#L41)) and the project
   could mount the upstream Python tool. Rejected — same install/proxy
   problems described in the `atlassian.ts` header that motivated
   native tools in the first place.
3. **Split into three sequential PRs (one per surface).**
   Easier code review, slower ship. Rejected — the user explicitly
   asked for one PR. Splitting would also force three separate ADR
   numbers and three sets of release notes for what is a single
   conceptual change ("the agent can now operate the full Atlassian
   surface").

## Decision Outcome

Chose **option 1**. Tools live in the existing two files; registration
goes through the existing
[`registerTools()`](../../lib/tools/registry.ts) call at the bottom
of each. UI surfaces (AgentEditor, BuiltinToolsPanel, ExtensionsPanel)
auto-discover via `GET /api/v1/tools` so no UI plumbing is needed.

### Tool inventory (33 total)

**Jira agile (10) — `/rest/agile/1.0/...`**
- `jira_list_boards`, `jira_get_board` (merges board + configuration),
  `jira_list_sprints`, `jira_get_sprint`, `jira_create_sprint`,
  `jira_update_sprint` (state transitions + name/goal/dates in one),
  `jira_delete_sprint` (destructive-confirm gate),
  `jira_move_issues_to_sprint`, `jira_move_issues_to_backlog`,
  `jira_rank_issues`.

Sprint-issue and backlog listing intentionally **omitted** — the
existing `jira_search` already does both via JQL (`sprint = N` and
`sprint is empty AND project = X`).

**Jira issue gaps (8) — `/rest/api/3/...`**
- `jira_get_comments` (paginated, beyond the ~50-cap embedded list),
  `jira_update_comment`, `jira_delete_comment`,
  `jira_get_attachment_content` (text/base64 auto-detect, mirrors
  `confluence_get_attachment_content`), `jira_delete_attachment`,
  `jira_add_worklog`, `jira_list_worklogs`, `jira_get_changelog`.

**Jira project metadata (8) — `/rest/api/3/...`**
- `jira_list_projects`, `jira_get_project` (versions/components/types
  via `expand`), `jira_list_versions`, `jira_create_version`,
  `jira_update_version` (release/unrelease/archive flags),
  `jira_list_components`, `jira_create_component`,
  `jira_list_meta` (single tool dispatching by `kind`:
  `issue_type | priority | status | resolution`).

**Confluence gaps (5) — v2 where available, v1 where forced**

Confluence v2 audit run live on 2026-05-28
([developer.atlassian.com/cloud/confluence/rest/v2/](https://developer.atlassian.com/cloud/confluence/rest/v2/)):

| Endpoint | Status |
| --- | --- |
| `DELETE /pages/{id}` (with `purge=true`) | ✓ v2 |
| `PUT /footer-comments/{comment-id}` + `DELETE` | ✓ v2 |
| `PUT /inline-comments/{comment-id}` + `DELETE` | ✓ v2 |
| Add/remove labels via v2 | ✗ still read-only (CONFCLOUD-76866 unresolved) |
| `DELETE /attachments/{id}` (with `purge=true`) | ✓ v2 |

- `confluence_delete_page` (destructive-confirm when `purge: true`),
  `confluence_update_comment` (`kind: footer | inline`),
  `confluence_delete_comment` (same routing),
  `confluence_remove_label` (v1 `DELETE /content/{id}/label?name=...`,
  matches the v1 fallback `confluence_add_label` already uses),
  `confluence_delete_attachment` (destructive-confirm when `purge: true`).

**Jira Align hierarchy (2) — `/rest/align/api/2/...`**
- `jira_align_list_entities`, `jira_align_get_entity`. New
  `ENTITY_TO_COLLECTION` map alongside the existing
  `TYPE_TO_COLLECTION`: `program → programs`, `team → teams`,
  `release → releases`, `sprint → sprints`, `portfolio → portfolios`,
  `value_stream → valueStreams`. Same up-front-rejection-on-unknown
  pattern as ADR-0021.

### Patterns

- **`omit-arg-to-list-options`** extends to `jira_update_sprint`
  (omit `state` to list valid transitions) and `jira_list_meta`
  (omit `kind` to list available kinds).
- **Two-arg destructive-confirm** from `jiraAlignDeleteItemTool`
  reused on `jira_delete_sprint`, `confluence_delete_page` (with
  `purge: true`), and `confluence_delete_attachment` (with
  `purge: true`).
- **Sprint state machine**: only `future → active → closed` is
  legal. The tool refuses other transitions client-side with the
  list of valid options, mirroring `jira_transition_issue`.

### Test + coverage strategy

- New unit tests follow the existing
  [atlassian.test.ts](../../lib/tools/atlassian.test.ts) pattern:
  pure-helper unit tests + mocked-fetch tool-callback tests via
  `vi.stubGlobal("fetch", fake)`. ~70 new `it()` blocks split
  across `atlassian-agile.test.ts`, `atlassian-issue-extras.test.ts`,
  `atlassian-project-meta.test.ts`, `atlassian-confluence.test.ts`,
  and `jira-align.test.ts` for review-friendly file sizes.
- [vitest.config.ts](../../vitest.config.ts) coverage exclude
  narrows from `lib/tools/**` to per-file: `lib/tools/atlassian.ts`
  and `lib/tools/jira-align.ts` are included in the gate; sibling
  files that hit live-network/SDK boundaries (e.g.
  `lib/tools/web-fetch.ts`) stay excluded with a one-line comment.
- The 80%/80%/80%/80% thresholds remain unchanged. Branch coverage
  is the tightest constraint; tests cover every conditional in new
  code.

## Consequences

**Positive**
- Agent can now drive sprint ceremonies (plan, start, complete, rank
  backlog) without shell-execing the `jira` CLI.
- Comment editing, worklogs, attachment download, and history are
  available — the agent can answer "what changed yesterday?" without a
  sidecar tool.
- Project metadata listing means the agent doesn't have to guess
  issue types, priorities, or statuses on a new site.
- JA hierarchy listing closes the "I see ids in the response but can't
  resolve names" gap.
- The new code is gated by the same 80% coverage bar as the rest of
  the codebase, so future changes can't silently regress.

**Negative / risks**
- Larger Atlassian-tools surface for the AgentEditor permission picker
  (~50 tools in the Atlassian category once this lands). Mitigation:
  the picker is searchable; tool names group lexicographically by
  prefix (`jira_*`, `confluence_*`, `jira_align_*`).
- Sprint state-machine drift: if Atlassian adds a new sprint state in
  the future, our client-side validator will reject it. Mitigation:
  the validator's allow-list is one constant; an issue or quick PR
  can update it. Worst case, omit `state` to list valid transitions
  (the API tells us).
- Confluence label remove still relies on v1 (CONFCLOUD-76866 open as
  of 2026-05-28). When v2 catches up, the tool flips to v2 with a
  one-line URL change; behaviour stays the same for callers.

## Out of scope

- Jira Service Management (JSM): queues, requests, SLAs, customers.
- Confluence blogposts / whiteboards / databases (newer content types
  added in 2024-25).
- Jira Align write operations on programs/teams/releases (read-only
  for now — these change via the JA admin UI, not via agent flows).
- Custom-field metadata (`createmeta` / `editmeta`) — agents already
  introspect via `jira_get_issue` with `custom_fields`.
- Bulk worklog or comment operations.
- Filters and dashboards.
- The v2 `body-format=storage,view` rejection symptom on
  `confluence_get_page` is a separate bugfix tracked outside this PR
  (see plan file `playful-squishing-gray.md`).

## More Information

- [ADR-0019: native Jira Align tool](0019-jira-align-tool.md)
- [ADR-0021: Jira Align type-aware routing](0021-jira-align-type-aware-routing.md)
- [ADR-0026: remote document sources](0026-remote-document-sources.md)
  (Confluence document-RAG indexer, on v1)
- Confluence v2 docs:
  [api-group-page](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/),
  [api-group-comment](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-comment/),
  [api-group-attachment](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-attachment/),
  [api-group-label](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-label/).
- Jira Agile API: `/rest/agile/1.0/` (separate REST family from the
  v3 platform API).
