# HTTP API reference

For client-side React integration contracts, see
[docs/ui-hook-api.md](./ui-hook-api.md).

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
- **Stream chunk types:** `text`, `thinking`, `tool_call`, `tool_result`, `tool_progress` (zero or more per call, live status from a still-running tool — ADR-0073), `usage`, `done` (see `lib/agents/base.ts` for the full union)

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

Query parameters:

- `q` — optional case-insensitive search across name, description, category,
  capability, source, and group.

- **Source:** [`app/api/v1/tools/route.ts`](../app/api/v1/tools/route.ts)
- **Agent equivalent:** `list_tools` tool — same data, callable from inside an agent run, with the same `query` search behavior.

---

## Skills

Packaged built-in skills are always readable. User skills are layered on top
from `JARELA_SKILLS_DIR` when configured and override built-ins with the same
id. Writes still require `JARELA_SKILLS_DIR` so packaged skills remain
read-only.

- **Sources:** [`lib/skills/index.ts`](../lib/skills/index.ts), [`app/api/v1/skills/route.ts`](../app/api/v1/skills/route.ts), [`app/api/v1/skills/[id]/route.ts`](../app/api/v1/skills/[id]/route.ts)
- **Agent equivalent:** `list_skills`, `read_skill`, and `write_skill` tools.

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

Receives a page-capture upload from the browser extension and routes it
into the most recently active thread on the default agent.

Request body (JSON):

| field                  | type   | required | notes                                                                                       |
| ---------------------- | ------ | -------- | ------------------------------------------------------------------------------------------- |
| `url`                  | string | yes      | Page URL the element was picked from.                                                       |
| `text`                 | string | yes      | Element text content (truncated to 100 KB UTF-8 server-side).                              |
| `capturedAt`           | string | yes      | ISO-8601 timestamp.                                                                         |
| `title`                | string | no       | Document title (≤500 chars).                                                                |
| `selector`             | string | no       | CSS selector path of the picked element (≤ 2000 chars).                                     |
| `tagName`              | string | no       | Tag name of the picked element (≤ 64 chars).                                                |
| `screenshot`           | string | no       | Base64-encoded PNG of just the picked element (≤ 4 MB encoded). No `data:` URL prefix.     |
| `screenshotMediaType`  | string | no       | MIME type for the screenshot (default `image/png`).                                         |

When `screenshot` is present the persisted user message is stored as a
multipart `ContentPart[]` of `[text, image]` so the chat UI renders the
picture inline and vision-capable models see it on the silent observer
turn that fires immediately after.

Response: `{ thread_id, msg_id, agent_id, agent_name, thread_title, created_thread, truncated, originalBytes }`.

### `OPTIONS /api/v1/page-capture`

CORS preflight.

- **Source:** [`app/api/v1/page-capture/route.ts`](../app/api/v1/page-capture/route.ts), [`lib/api/page-capture.ts`](../lib/api/page-capture.ts)
- **Auth:** loopback only (`Host:` must be `localhost` / `127.0.0.1`); CORS reflects the request `Origin` so the extension passes preflight.

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
