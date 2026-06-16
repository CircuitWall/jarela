# @circuitwall/ms-todo-langchain

LangChain tools for **Microsoft To Do** via the Microsoft Graph
(`/me/todo`) — direct REST calls, no MCP, no Graph SDK, no extra
processes.

> Extracted from [Jarela](https://github.com/CircuitWall/jarela). Works in
> any Node 20+ LangChain.js / LangGraph project. Inherits whatever HTTP
> proxy + CA bundle the host runtime configures, so it works on
> locked-down corp networks where the MCP install path is blocked.

## Install

```bash
npm install @circuitwall/ms-todo-langchain @langchain/core zod
```

`@langchain/core` and `zod` are peer dependencies — bring your own
version.

## Quick start

```ts
import {
  setAuthResolver,
  msTodoListListsTool,
  msTodoCreateTaskTool,
  msTodoTools,
} from "@circuitwall/ms-todo-langchain";

// Option A: rely on env vars. The package will run the OAuth refresh
// flow internally on every call (cached for the token's lifetime).
//
//   MS_TODO_CLIENT_ID=<azure app client id>
//   MS_TODO_CLIENT_SECRET=<azure app client secret>
//   MS_TODO_REFRESH_TOKEN=<delegated refresh_token with Tasks.ReadWrite + offline_access>
//   MS_TODO_TENANT=common   # optional; "common" works for personal + M365
//
// Or, for short-lived script use, MS_TODO_ACCESS_TOKEN.

// Option B: plug in your own credential source (vault, UI form, an
// embedder that already runs the refresh flow elsewhere).
setAuthResolver(async () => ({ access_token: await mintAccessToken() }));

// Use individual tools …
const lists = await msTodoListListsTool.invoke({});

// … or pass the whole array to a LangGraph agent.
const agent = await createReactAgent({ llm, tools: [...msTodoTools] });
```

## What's in the box

12 tools covering the Microsoft To Do surface of Microsoft Graph.

### Task lists
- `ms_todo_list_lists`
- `ms_todo_create_list`
- `ms_todo_update_list`
- `ms_todo_delete_list`

### Tasks
- `ms_todo_list_tasks` — `$filter` on status / importance / due window
- `ms_todo_get_task`
- `ms_todo_create_task` — title, body, importance, due, reminder, categories
- `ms_todo_update_task` — patch any subset; `clear_due` / `clear_reminder` to remove dates
- `ms_todo_complete_task` — convenience: PATCH status='completed'
- `ms_todo_delete_task`

### Checklist sub-items
- `ms_todo_list_checklist_items`
- `ms_todo_add_checklist_item`

## Capability groups

For tool-policy systems that need read / write partitions:

```ts
import {
  msTodoReadTools,    // 4 read-only tools
  msTodoWriteTools,   // 8 mutating tools
} from "@circuitwall/ms-todo-langchain";
```

There is no `execute` bucket — Microsoft To Do has no irreversible
side-effect operations beyond plain delete, which is in `write`.

## Low-level escape hatch

For Graph endpoints not yet wrapped as tools:

```ts
import { graphFetch } from "@circuitwall/ms-todo-langchain";

const data = await graphFetch("/me/todo/lists/<id>/tasks/<task-id>/attachments");
```

`graphFetch` uses the same auth resolver as the tools, so plug in once
and it works everywhere.

## Auth — required Azure setup

1. **Register an app** at
   [portal.azure.com → Microsoft Entra ID → App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade).
   Pick "Accounts in any organizational directory and personal Microsoft
   accounts" for the broadest reach.
2. **Add a Web redirect URI** that matches where your OAuth callback
   listens.
3. **API permissions → Microsoft Graph → Delegated permissions**, add:
   - `Tasks.ReadWrite`
   - `offline_access`
4. **Certificates & secrets → New client secret**. Copy the **value**
   immediately — Azure only shows it once.
5. Run the OAuth2 authorization-code flow once to mint a
   `refresh_token`. Pass `prompt=consent` and `scope=offline_access
   Tasks.ReadWrite` to the
   `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`
   endpoint.

## Notes

- **Datetimes:** Graph rejects `Z`-suffixed strings on `dueDateTime` and
  `reminderDateTime`. The package strips a trailing `Z` and defaults the
  `timeZone` to `UTC`. Pass `due_time_zone` / `reminder_time_zone` for
  any other IANA zone.
- **Default list:** the user's main "Tasks" inbox shows up with
  `wellknownListName: "defaultList"`. Its display name is locale-aware,
  so always resolve by the well-known marker, not by name.
- **Personal vs work accounts:** both work via the `common` tenant.
  Microsoft To Do is fully available on personal accounts and M365.
  Some Graph endpoints (e.g. Teams meetings) are work-only; To Do is
  not one of them.
- **Rate limits:** Graph applies a 10,000-requests-per-10-minutes per-app
  budget for delegated calls. The package does not retry on 429 — you
  should not hit it under normal agent use.

## License

[Apache-2.0](./LICENSE)
