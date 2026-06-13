# @circuitwall/atlassian-langchain

LangChain tools for **Atlassian Jira** and **Confluence Cloud** — direct REST
calls, no MCP server required, works through corporate `HTTPS_PROXY`.

Extracted from [Jarela](https://github.com/CircuitWall/jarela) so any
LangGraph / LangChain.js agent can give an LLM the same Jira + Confluence
toolbelt without running the full Jarela stack.

## Why

The official `mcp-atlassian` server is great, but on locked-down corporate
networks the npm/PyPI install step is often blocked and the extra process is
operationally awkward. This package skips MCP entirely: every tool is a tiny
`fetch()` against the Atlassian REST API, gated by HTTP Basic auth (email +
API token). Same network path your browser already uses.

64 tools, two products, one install.

## Install

```bash
npm i @circuitwall/atlassian-langchain @langchain/core zod
```

`@langchain/core` and `zod` are peer dependencies — bring whichever versions
your agent already uses (core ≥ 0.3, zod ≥ 3.23).

## Quick start

```ts
import {
  setAuthResolver,
  atlassianReadTools,
  atlassianWriteTools,
} from "@circuitwall/atlassian-langchain";

// Option A — env vars (default). No setup needed if these are set:
//   ATLASSIAN_URL=https://your-team.atlassian.net
//   ATLASSIAN_EMAIL=you@example.com
//   ATLASSIAN_API_TOKEN=...

// Option B — supply your own resolver (e.g. read from a secrets store):
setAuthResolver(() => ({
  url: "https://your-team.atlassian.net",
  email: "you@example.com",
  apiToken: process.env.MY_VAULT_ATLASSIAN_TOKEN!,
}));

// Hand the tools to your agent:
import { createReactAgent } from "@langchain/langgraph/prebuilt";
const agent = createReactAgent({
  llm: yourModel,
  tools: [...atlassianReadTools, ...atlassianWriteTools],
});
```

Each tool resolves auth lazily on every call, so it's safe to import the
tools at module load and configure the resolver later.

## What's included

### Jira (42 tools)

- **Search & read** — `jira_search` (JQL), `jira_get_issue`,
  `jira_find_user`, `jira_get_comments`, `jira_list_worklogs`,
  `jira_get_changelog`, `jira_get_attachment_content`.
- **Issue lifecycle** — `jira_create_issue`, `jira_create_issues_bulk`,
  `jira_update_issue`, `jira_delete_issue`, `jira_transition_issue`,
  `jira_add_worklog`.
- **Comments & attachments** — `jira_add_comment`, `jira_update_comment`,
  `jira_delete_comment`, `jira_upload_attachment`, `jira_delete_attachment`.
- **Links** — `jira_link_issues`, `jira_delete_link`,
  `jira_add_remote_link`.
- **Agile** — `jira_list_boards`, `jira_get_board`, `jira_list_sprints`,
  `jira_get_sprint`, `jira_create_sprint`, `jira_update_sprint`,
  `jira_delete_sprint`, `jira_move_issues_to_sprint`,
  `jira_move_issues_to_backlog`, `jira_rank_issues`.
- **Project metadata** — `jira_list_projects`, `jira_get_project`,
  `jira_list_versions`, `jira_create_version`, `jira_update_version`,
  `jira_list_components`, `jira_create_component`, `jira_list_meta`.

### Confluence (22 tools)

- **Read** — `confluence_search` (CQL), `confluence_get_page`,
  `confluence_get_page_by_title`, `confluence_get_page_children`,
  `confluence_get_page_ancestors`, `confluence_list_spaces`,
  `confluence_get_comments`, `confluence_list_attachments`,
  `confluence_get_labels`, `confluence_get_attachment_content`.
- **Write** — `confluence_create_page`, `confluence_update_page`,
  `confluence_delete_page`, `confluence_move_page`,
  `confluence_add_comment`, `confluence_update_comment`,
  `confluence_delete_comment`, `confluence_upload_attachment`,
  `confluence_delete_attachment`, `confluence_add_label`,
  `confluence_remove_label`.

### Capability arrays

For agents that want to gate by capability:

```ts
import {
  atlassianReadTools,    // 26 read-only tools
  atlassianWriteTools,   // 37 mutating tools
  atlassianExecuteTools, // 1 status-change tool (jira_transition_issue)
} from "@circuitwall/atlassian-langchain";
```

### Pure helpers

- `confluenceTextToStorage(text)` — plain text → Confluence storage XHTML.
- `parseV2NextCursor(linksNext)` — extract the opaque cursor from a v2
  `_links.next` URL.
- `resolveCustomFieldNames(inputs, fields)` — map display names / IDs to
  Jira field IDs.
- `extractFieldValue(raw, renderedHTML)` — coerce a Jira field value into
  something an LLM can read.
- `validateSprintTransition(currentState, targetState)` — guard against
  invalid sprint state transitions.

### Low-level escape hatch

```ts
import { atlassianFetch } from "@circuitwall/atlassian-langchain";

const data = await atlassianFetch(
  { url: "...", email: "...", apiToken: "..." },
  "/rest/api/3/myself",
);
```

Use this when you need a Jira/Confluence endpoint that isn't wrapped as a
tool yet. Returns the parsed JSON, or `{ error, url }` on non-2xx.

## Auth tokens

Atlassian Cloud uses HTTP Basic with **email + API token** (NOT password).
Create one at <https://id.atlassian.com/manage-profile/security/api-tokens>.
Server / Data Center editions are not currently supported — open an issue
if you need them.

## License

Apache-2.0. See [LICENSE](./LICENSE).
