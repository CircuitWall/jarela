# @circuitwall/jira-align-langchain

LangChain tools for Atlassian Jira Align (portfolio / SAFe agile) — direct REST calls, no MCP, proxy-aware.

> Extracted from [Jarela](https://github.com/CircuitWall/jarela). Works in any
> Node 20+ LangChain.js / LangGraph project. Inherits whatever HTTP proxy +
> CA bundle the host runtime configures, so it works on locked-down corp
> networks where the MCP install path is blocked.

## Install

```bash
npm install @circuitwall/jira-align-langchain @langchain/core zod
```

`@langchain/core` and `zod` are peer dependencies — bring your own version.

## Quick start

```ts
import {
  setAuthResolver,
  jiraAlignSearchItemsTool,
  jiraAlignGetItemTool,
  jiraAlignTools,
} from "@circuitwall/jira-align-langchain";

// Option A: rely on env vars (JIRA_ALIGN_URL, JIRA_ALIGN_TOKEN). Nothing to do.

// Option B: plug in your own credential source (vault, UI form, …).
setAuthResolver(() => ({
  url: "https://acme.jiraalign.com",
  apiToken: process.env.MY_JIRA_ALIGN_TOKEN ?? "",
}));

// Use individual tools …
const result = await jiraAlignGetItemTool.invoke({
  type: "feature",
  item_id: "12345",
});

// … or pass the whole array to a LangGraph agent.
const agent = await createReactAgent({ llm, tools: [...jiraAlignTools] });
```

## What's in the box

22 tools covering Jira Align v2:

### Work items (read)
- `jira_align_get_item` — fetch a single item
- `jira_align_search_items` — OData-filterable list per type
- `jira_align_list_children` — walk the hierarchy by parent_id

### Work items (write)
- `jira_align_create_item`
- `jira_align_update_item`
- `jira_align_delete_item` (confirm-gated)
- `jira_align_transition_item` — workflow state change

### Comments
- `jira_align_list_comments`
- `jira_align_add_comment`
- `jira_align_update_comment`
- `jira_align_delete_comment` (confirm-gated)

### Hierarchy entities
- `jira_align_list_entities` — programs / teams / releases / sprints / portfolios / value streams
- `jira_align_get_entity`
- `jira_align_create_entity`
- `jira_align_update_entity`
- `jira_align_delete_entity` (confirm-gated)

### Dependencies (cross-item links)
- `jira_align_list_dependencies`
- `jira_align_create_dependency`
- `jira_align_delete_dependency` (confirm-gated)

## Capability groups

For tool-policy systems that need read / write / execute partitions:

```ts
import {
  jiraAlignReadTools,    // 7 read-only tools
  jiraAlignWriteTools,   // 14 mutating tools (incl. deletes)
  jiraAlignExecuteTools, // 1 transition tool
} from "@circuitwall/jira-align-langchain";
```

## Low-level escape hatch

For endpoints not yet wrapped as tools:

```ts
import { jiraAlignFetch, resolveJiraAlignAuthFromEnv } from "@circuitwall/jira-align-langchain";

const auth = resolveJiraAlignAuthFromEnv();
if (!("error" in auth)) {
  const data = await jiraAlignFetch(auth, "/rest/align/api/2/programs?limit=10");
}
```

## API notes

- **v2 has no `/items` endpoint.** Every tool that touches a work item takes a
  required `type` arg so the package can route to the right `/<type>s` collection
  (epic / capability / feature / story / theme / task / defect / objective).
- **Field shapes vary by instance.** JA exposes custom fields, custom workflow
  states, and instance-specific portfolio configs. If a tool 4xx's on what
  looks like a valid call, check your instance's Swagger at
  `<instance>.jiraalign.com/rest/align/api/docs/`.
- **Auth is bearer, not basic.** Jira Align uses a single API token (created in
  Settings → Personal Access Tokens), NOT email + token like Jira Cloud.

## License

Apache-2.0
