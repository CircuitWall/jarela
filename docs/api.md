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

Read messages (paged or "after a marker") for one thread. `before`/`after`
are message `seq` values (the server-assigned monotonic order), not
timestamps — pass the `seq` of the oldest/newest message you already have.

Pass `view=metadata` to read only thread metadata, context boundaries, summaries,
and activity, without querying or serializing messages or their usage snapshots.
This response omits `messages` and `has_more`. The default `view=messages`
preserves the full paged response. Unknown views return HTTP 400.
Both views use `Cache-Control: no-store` so live state stays current.

### `PATCH /api/v1/threads/[thread_id]/messages/[message_id]`

Set whether a message appears in the chat window without removing it from
model history. Body: `{ "hidden_from_chat": boolean }`. The message must
belong to the specified thread.

### `PATCH /api/v1/threads/[thread_id]`

Rename or rebind the thread to a different agent.

### `DELETE /api/v1/threads/[thread_id]`

Drop the thread, its messages, and its checkpoint state. Attachment and
generated files under `<dataDir>/files/` that no other message or memory entry
references are deleted immediately rather than waiting for the retention GC.

- **Source:** [`app/api/v1/threads/[thread_id]/route.ts`](../app/api/v1/threads/[thread_id]/route.ts)

### `POST /api/v1/threads/[thread_id]/run`

Submit a run. Returns `202 { accepted, thread_id, queue_position }` after the
user message and assistant draft are committed; output is streamed via the GET
on the same path.

### `GET /api/v1/threads/[thread_id]/run`

Subscribe to the in-flight run as a Server-Sent Events stream. Reconnects
resume from the last seen sequence id.

### `PATCH /api/v1/threads/[thread_id]/run`

Steer the run that is already streaming (ADR-0080). Body: `{ "message": "…" }`.
The message is queued and delivered before the agent's next model call,
alongside the tool results it should react to — the run is not aborted.
Returns `409 { "steered": false }` when no run is active, in which case submit a
normal `POST` instead.

### `DELETE /api/v1/threads/[thread_id]/run`

Abort the in-flight run. This is the only interrupt; typing mid-run steers.

- **Source:** [`app/api/v1/threads/[thread_id]/run/route.ts`](../app/api/v1/threads/[thread_id]/run/route.ts)
- **Stream chunk types:** `text`, `thinking`, `tool_call`, `tool_result`, `tool_progress` (zero or more per call, live status from a still-running tool — ADR-0073), `reset_text` (discard prior live text before an output-validator replacement retry), `usage`, `done` (see `lib/agents/base.ts` for the full union)

---

## Agents

### `GET /api/v1/agents`

List configured agents.

### `GET /api/v1/agents/recent-replies`

Return each agent's latest non-empty, completed assistant reply as
`{ agent_id, content }` entries. Agents without a completed reply are omitted.

### `POST /api/v1/agents`

Upsert an agent config. The full schema (identity, instructions, tools,
model_config_name, harness_id, delegation, etc.) lives in
[`lib/stores/agent-configs.ts`](../lib/stores/agent-configs.ts).
`warm_summary_limit` controls recent summarized context (default 50 messages;
0 disables warm summaries) independently from `history_limit`'s raw history
cap.
`usage_strategy` may be `cost_saving`, `balanced`, or `high_reasoning`; pass
`null` to inherit the global `JARELA_USAGE_STRATEGY` setting.
`usage_profile` accepts `home`, `work`, `dev`, or `custom` (Everything; the
default). Omission on update preserves the saved profile. This controls prompt
style, chat diagnostic presentation, and credential discovery, not permissions.
API updates only persist the profile: the agent editor separately submits its
style/citation defaults, which callers may also set explicitly.
Direct style fields are `adaptive_empathy` (warmth), `adaptive_expressiveness`,
`adaptive_verbosity` (response detail), and `adaptive_persona_strength`
(conversational-cue adaptation), each 0-100. `adaptive_persona_enabled` enables
these style targets; disabling it preserves their values and still applies the
profile's organization. Strength 0 disables cue-based adjustments.
`adaptive_mbti` is deprecated compatibility data: it is retained on existing
records but does not influence prompts or reset style sliders.

- **Source:** [`app/api/v1/agents/route.ts`](../app/api/v1/agents/route.ts)

### `GET / PATCH / DELETE /api/v1/agents/[id]`

Read, update, or delete one agent config.

- **Source:** [`app/api/v1/agents/[id]/route.ts`](../app/api/v1/agents/[id]/route.ts)

### `POST /api/v1/agents/[id]/duplicate`

Copy every setting of an agent into a new, non-default agent so a tuned setup
can be reused as a personal template. Optional body `{ "name": "…" }`; the
default name is `"<name> (copy)"`. Conversations are not copied. Returns
`201` with the new agent, `404` for an unknown agent, `400` for a blank name.

- **Source:** [`app/api/v1/agents/[id]/duplicate/route.ts`](../app/api/v1/agents/[id]/duplicate/route.ts)

---

## Tools

### `GET /api/v1/tools`

Returns every tool in the agent's pool with `{ name, description, source,
category, capability, group, mcp_server, stats }`. Source is
`builtin | external | mcp`. Capability is `read | write | execute`.
`mcp_server` is populated for MCP-sourced tools so clients can render
`MCP -> server -> tools` permission hierarchies.

Query parameters:

- `q` — optional case-insensitive search across name, description, category,
  capability, source, group, and MCP server.

- **Source:** [`app/api/v1/tools/route.ts`](../app/api/v1/tools/route.ts)
- **Agent equivalent:** `list_tools` tool — same data, callable from inside an agent run, with the same `query` search behavior.

---

## Skills

Packaged built-in skills are always readable. User skills are layered on top
from the repos in the `skill_repos` DB table (ADR-0074) and override built-ins
with the same id. Repos are scanned in the order they were added — a later
repo's skill overrides an earlier repo's (and built-ins) on id collision, so
a team-shared repo can be layered under a personal one. Writes and deletes
always target the one repo flagged `writable`, so the rest can be read-only
clones; `POST /api/v1/skills` and friends 503 with "No writable skill repo is
configured" until at least one repo exists (the first repo created becomes
writable automatically unless `writable: false` is passed explicitly).

### `GET /api/v1/skills/repos`

List configured skill repos: `{ repos: [{ id, path, label, writable, enabled, created_at, updated_at }] }`.

### `POST /api/v1/skills/repos`

Add a repo. Body: `{ path, label?, writable? }`. `path` must already exist
and be a directory; 409 if a repo for that path already exists.

### `GET|PATCH|DELETE /api/v1/skills/repos/[id]`

Fetch, update (`{ label?, enabled?, writable? }`), or remove one repo.
Setting `writable: true` on one repo clears it on any other.

- **Sources:** [`lib/skills/index.ts`](../lib/skills/index.ts), [`lib/stores/skill-repos.ts`](../lib/stores/skill-repos.ts), [`app/api/v1/skills/route.ts`](../app/api/v1/skills/route.ts), [`app/api/v1/skills/[id]/route.ts`](../app/api/v1/skills/[id]/route.ts), [`app/api/v1/skills/repos/route.ts`](../app/api/v1/skills/repos/route.ts), [`app/api/v1/skills/repos/[id]/route.ts`](../app/api/v1/skills/repos/[id]/route.ts)
- **Agent equivalent:** `list_skills`, `read_skill`, and `write_skill` tools (repo management has no agent tool yet — API only).

---

## Models

### `GET /api/v1/models`

List model configs (per-model parameter presets that agents bind to). Each row includes `is_default` and `enabled`.

### `POST /api/v1/models`

Upsert a model config. Omitting `is_default` keeps the existing flag; `is_default: true` clears the flag on every other row and re-enables the model.

- **Source:** [`app/api/v1/models/route.ts`](../app/api/v1/models/route.ts)

### `PATCH /api/v1/models/[name]`

Change model state without rewriting params. Body: `{ "enabled"?: boolean, "is_default"?: true }` (at least one field; `enabled: false` with `is_default: true` is rejected with 400). Each request runs in one transaction:

- `is_default: true` moves the default to this model. Returns 409 if the model is disabled.
- `enabled: false` hides the model from model selection and runtime default/router resolution. Disabling the default promotes the first other enabled model. Disabling the last enabled model returns 409.
- Returns 404 for an unknown model.

See [ADR-0102](adr/0102-model-config-enable-toggle.md).

- **Source:** [`app/api/v1/models/[name]/route.ts`](../app/api/v1/models/[name]/route.ts)

---

## Providers

### `GET /api/v1/providers`

Lists every registered LLM provider name (built-in + external `.cjs`
plugins under `~/.jarela/providers/`).

- **Source:** [`app/api/v1/providers/route.ts`](../app/api/v1/providers/route.ts)
- **Agent equivalent:** `list_providers` and `describe_provider` tools.

### `GET /api/v1/providers/{provider}/models`

Lists models available from the selected provider. For OpenAI, Anthropic,
Gemini, DeepSeek, GitHub Copilot, and provider plugins that implement
`listModels`, Jarela discovers models from the provider API when credentials
are configured. Anthropic, Gemini, and DeepSeek use curated lists when no API
key is configured; GitHub Copilot may also use its curated list when live
discovery is unavailable. GET results are cached per provider for up to
10 minutes; add `?fresh=1` to bypass that server cache.

`POST` to the same route accepts `{ "params": { ... } }` for credentials or
endpoint settings not yet saved in the model config. These responses are not
cached.

- **Source:** [`app/api/v1/providers/[provider]/models/route.ts`](../app/api/v1/providers/[provider]/models/route.ts)

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
- `/api/v1/threads/[thread_id]/activity`
- `/api/v1/threads/[thread_id]/context-pin`
- `/api/v1/delegations/codex/[job_id]`
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
