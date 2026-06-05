# HTTP API reference

This page lists every route that is part of Jarela's stable HTTP API. **A
route is part of the contract only if its source file carries a `@public`
JSDoc header**; everything else under `app/api/v1/*` is considered UI-internal
and may change between minor versions.

The contract follows the deprecation policy in
[CONTRIBUTING.md → Public API surface](../CONTRIBUTING.md#public-api-surface):
deprecate in `0.X.0`, remove no earlier than `0.(X+1).0`.

> **Auth.** All routes require a same-origin request (or the loopback bypass
> for the bin/CLI). See `lib/auth/access.ts`. CORS is opened only on the
> page-capture endpoint, for the browser extension.
>
> **Schemas.** Request/response shapes are validated with `zod` at the route
> boundary. The schema location is given per-route below — link directly into
> the source for the authoritative shape.
>
> **Versioning.** All routes live under `/api/v1`. A v2 prefix would only
> appear on a major bump.

---

## Health

### `GET /api/v1/health`

Liveness/readiness probe. Returns `{ ok, db_path, agent_count, master_key_source, version }`.

- **Source:** [`app/api/v1/health/route.ts`](../app/api/v1/health/route.ts)
- **Used by:** browser extension heartbeat, external uptime monitors
- **Auth:** loopback or same-origin

---

## Threads

A thread is a single conversation; messages, tool calls, and run state all
live inside one.

### `GET /api/v1/threads`

List threads, newest first.

### `POST /api/v1/threads`

Create a thread bound to an agent.

- **Source:** [`app/api/v1/threads/route.ts`](../app/api/v1/threads/route.ts)
- **Body schema:** `{ agent_id: string, title?: string }`

### `GET /api/v1/threads/[thread_id]`

Read messages (paged or "after a marker") for one thread.

### `PATCH /api/v1/threads/[thread_id]`

Rename or rebind the thread to a different agent.

### `DELETE /api/v1/threads/[thread_id]`

Drop the thread, its messages, and its checkpoint state.

- **Source:** [`app/api/v1/threads/[thread_id]/route.ts`](../app/api/v1/threads/[thread_id]/route.ts)

### `POST /api/v1/threads/[thread_id]/run`

Submit a run. Returns immediately with the run id; output is streamed via
the GET on the same path.

### `GET /api/v1/threads/[thread_id]/run`

Subscribe to the in-flight run as a Server-Sent Events stream. Reconnects
resume from the last seen sequence id.

- **Source:** [`app/api/v1/threads/[thread_id]/run/route.ts`](../app/api/v1/threads/[thread_id]/run/route.ts)
- **Stream chunk types:** `text`, `thinking`, `tool_call`, `tool_result`, `usage`, `done` (see `lib/agents/base.ts` for the full union)

---

## Agents

### `GET /api/v1/agents`

List configured agents.

### `POST /api/v1/agents`

Upsert an agent config. The full schema (identity, instructions, tools,
model_config_name, harness_id, delegation, etc.) lives in
[`lib/stores/agent-configs.ts`](../lib/stores/agent-configs.ts).

- **Source:** [`app/api/v1/agents/route.ts`](../app/api/v1/agents/route.ts)

### `GET / PATCH / DELETE /api/v1/agents/[id]`

Read, update, or delete one agent config.

- **Source:** [`app/api/v1/agents/[id]/route.ts`](../app/api/v1/agents/[id]/route.ts)

---

## Tools

### `GET /api/v1/tools`

Returns every tool in the agent's pool with `{ name, description, source,
category, capability, group, stats }`. Source is `builtin | external | mcp`.
Capability is `read | write | execute`.

- **Source:** [`app/api/v1/tools/route.ts`](../app/api/v1/tools/route.ts)
- **Agent equivalent:** `list_tools` tool — same data, callable from inside an agent run.

---

## Models

### `GET /api/v1/models`

List model configs (per-model parameter presets that agents bind to).

### `POST /api/v1/models`

Upsert a model config.

- **Source:** [`app/api/v1/models/route.ts`](../app/api/v1/models/route.ts)

---

## Providers

### `GET /api/v1/providers`

Lists every registered LLM provider name (built-in + external `.cjs`
plugins under `~/.jarela/providers/`).

- **Source:** [`app/api/v1/providers/route.ts`](../app/api/v1/providers/route.ts)
- **Agent equivalent:** `list_providers` and `describe_provider` tools.

---

## Page capture (browser extension)

### `POST /api/v1/page-capture`

Receives a page-capture upload (URL, title, selected/full text) from the
browser extension and routes it into the active thread.

### `OPTIONS /api/v1/page-capture`

CORS preflight.

- **Source:** [`app/api/v1/page-capture/route.ts`](../app/api/v1/page-capture/route.ts)
- **Auth:** opened to the extension's origin via CORS; same-origin from the app.

---

## Events (notification stream)

### `GET /api/v1/events`

Server-Sent Events stream of in-process notifications: run completion,
watcher fires, queue progress, bridge messages.

- **Source:** [`app/api/v1/events/route.ts`](../app/api/v1/events/route.ts)
- **Event types:** see `lib/notifications/bus.ts` for the full union (`run_completed`, `task_completed`, `bridge_message_received`, etc.)

---

## Out of scope (UI-internal routes)

The following endpoints exist but are NOT part of this contract — they
serve the in-app UI and are subject to change without notice:

- `/api/v1/health/probes`
- `/api/v1/events/test`
- `/api/v1/threads/[thread_id]/context-pin`
- `/api/v1/agents/[id]/compact`, `/display-filters`, `/thread`
- `/api/v1/models/[name]`
- `/api/v1/providers/[provider]/models`, `/github-copilot/auth`
- `/api/v1/extensions/...`
- `/api/v1/integrations/...`
- `/api/v1/mcp-servers/...`
- `/api/v1/scheduled-tasks/...`
- `/api/v1/watchers/...`
- `/api/v1/memory/...`
- `/api/v1/dashboard/...`
- `/api/v1/voice/...`
- `/api/v1/documents/...`
- `/api/v1/env-sync/...`
- `/api/v1/proxy-config/...`
- `/api/v1/access/...`
- `/api/v1/config/...`
- `/api/v1/harnesses/...`

If you build something that depends on any of these, file an issue so we
can decide whether to promote them to `@public`.
