---
status: "accepted"
date: 2026-05-23
deciders: Andrew
consulted:
informed:
---

# Per-agent message-channel taxonomy and persisted display filters

## Context and Problem Statement

Today the chat panel already classifies streamed/persisted content into
distinct channels, but the taxonomy is fragmented across three layers
and the user's display preference is a single global localStorage key:

1. **Wire (SSE chunks, ADR-0008):** `text_delta`, `tool_call`,
   `tool_result`, `thinking_delta`, `done`, `error`.
2. **Persistence (`messages` table):** `role` (`user|assistant`) plus an
   optional `category` string (`scheduled_task`, `bridge`, `synthetic`,
   or `NULL` for ordinary chat). Tool events live in a sibling
   `PersistedToolEvent[]` attached to the assistant message.
3. **UI (`useMessageFilters`):** five toggles —
   `scheduled_task | bridge | synthetic | tool_use | thinking` —
   persisted in `localStorage` under `jarela:msg-category-filters`,
   shared across every agent and every thread.

Two concrete problems:

- **No documented taxonomy.** The mapping between SSE chunk types and
  persisted `category` values is implicit. New contributors (and new
  channels — e.g. a future `notice` or `handoff`) have nowhere to look.
- **Filter prefs are global.** A user who wants a noisy Ops agent to
  show tool calls but a chatty companion agent to hide them has to flip
  the toggle every time they switch threads. The preference is properly
  per-agent, not per-browser.

## Decision Drivers

* Keep the current rendering pipeline — no visual redesign in scope.
* Keep `messages.category` semantics stable; this is an additive change.
* Single Next.js process invariant (CLAUDE.md) — no new daemons.
* All persistent state goes through `lib/db` / `lib/stores`.
* Forward-compat for future channels without a schema migration each time.

## Considered Options

* **A. Status quo + docs.** Just document the existing taxonomy. Cheapest,
  but leaves the per-agent UX gap unsolved.
* **B. Per-agent filter column on `agent_configs`.** Add a single
  `display_filters` TEXT column (JSON map). Persisted via existing
  agent store; loaded into `useMessageFilters` keyed by `agent_id`.
* **C. Separate `agent_ui_prefs` table.** Normalized one-row-per-(agent,
  pref-key). Most flexible but overkill — these prefs are
  cohesive and always read/written together with the agent.

## Decision Outcome

Chosen: **Option B** — extend `agent_configs` with a single nullable
JSON column `display_filters`, and formalize the message-channel
taxonomy in this ADR so all three layers reference the same names.

### Channel taxonomy (canonical)

| Channel key       | Origin                                              | Persisted as                                  | Default visible |
|-------------------|-----------------------------------------------------|-----------------------------------------------|-----------------|
| `user`            | Human turn                                          | `messages.role='user'`, `category=NULL`       | yes (always)    |
| `assistant`       | Model reply text                                    | `messages.role='assistant'`, `category=NULL`  | yes (always)    |
| `thinking`        | `thinking_delta` SSE chunks                         | not persisted (live-only)                     | yes             |
| `tool_use`        | `tool_call` + `tool_result` SSE chunks              | `PersistedToolEvent[]` on assistant message   | yes             |
| `scheduled_task`  | Scheduler-triggered turn (visible firings)          | `messages.category='scheduled_task'`          | yes             |
| `bridge`          | Bridge adapter traffic (WhatsApp, etc.)             | `messages.category='bridge'`                  | yes             |
| `synthetic`       | Page captures, file-upload synthetic user messages  | `messages.category='synthetic'`               | yes             |

`user` and `assistant` are intentionally **not filterable** — hiding
either would render the thread incoherent. They appear in the taxonomy
for completeness (so future contributors know the full enum).

Future channels (e.g. `notice`, `handoff`, `voice`) extend this table
without a schema change: they get a new `category` string value and a
new entry in the `MESSAGE_FILTER_KEYS` constant. Unknown categories
received by an older client render as visible (forward-compat rule
already in `MessageList.tsx`).

### Persistence

Add one column to `agent_configs`:

```sql
ALTER TABLE agent_configs ADD COLUMN display_filters TEXT;
-- JSON shape: { "thinking": true, "tool_use": true,
--               "scheduled_task": true, "bridge": true,
--               "synthetic": true }
-- NULL = inherit defaults (all-on). Missing keys = default-on.
```

Migration: forward-only, no backfill needed (NULL is the documented
"inherit defaults" state). Lives in the existing `lib/db` migration
runner.

Read path: `getAgentConfig(id)` returns the parsed object (or `null`).
Write path: a new `updateAgentDisplayFilters(id, patch)` helper merges
over the stored object so callers can flip one key at a time without
a read-modify-write race.

### UI changes (minimal, no rendering rework)

- `useMessageFilters` takes `agentId` as an argument. It reads the
  per-agent prefs via a small `/api/v1/agents/:id/display-filters`
  endpoint, falls back to defaults while loading, and writes through
  the same endpoint on toggle. The `localStorage` cache stays as a
  warm-start hint keyed by agent id (`jarela:msg-filters:<agentId>`)
  so the toolbar doesn't flicker on reload.
- The chat-panel filter toolbar (`FilterToolbar` in
  `components/chat/MessageList.tsx`) is unchanged structurally — it
  already reads from the hook. Only the hook's source-of-truth moves.
- A "Reset to defaults" affordance is added to the toolbar's overflow
  menu (writes `NULL` back to the column).

### API surface

```
GET  /api/v1/agents/:id/display-filters   -> { filters: {...} | null }
PUT  /api/v1/agents/:id/display-filters   body: { filters: {...} | null }
```

Validated with `zod` at the boundary (CLAUDE.md convention). The PUT
accepts a partial map and merges server-side.

### Removed / unchanged

- Global `jarela:msg-category-filters` localStorage key is **removed**
  after a one-shot migration that, on first run, copies it into the
  default agent's `display_filters` and deletes the global key. Other
  agents start from defaults. This avoids a silent UX regression for
  the existing user.
- `messages.category` semantics: unchanged.
- SSE chunk types: unchanged.
- Tool-event persistence shape: unchanged.

## Consequences

### Good

* Per-agent filter prefs feel right — noisy Ops agent vs. quiet
  companion agent can diverge without per-thread fiddling.
* Single canonical channel table lives in this ADR; the three layers
  (wire / persistence / UI) now reference the same names.
* Forward-compat for new channels without further ADRs (additive
  enum, not a schema change).

### Bad / accepted

* One more JSON column on `agent_configs`. Acceptable — same pattern
  as the `adaptive_*` columns already there.
* Two extra HTTP calls on agent switch (GET filters; subsequent PUT
  on toggle). Cached in localStorage by agent id, so steady-state
  reads are warm.

## Pros and Cons of the Options

### A — Status quo + docs

* Good: zero code.
* Bad: doesn't solve the per-agent UX problem the user actually asked
  for.

### B — Column on `agent_configs` (chosen)

* Good: cohesive with existing per-agent columns; one query path; one
  migration; minimal API surface.
* Neutral: JSON blob in a column is less queryable than a normalized
  table — but these prefs are only ever read whole, never aggregated.
* Bad: schema change requires a migration (cheap, forward-only).

### C — Separate `agent_ui_prefs` table

* Good: maximally flexible for future unrelated UI prefs.
* Bad: extra join on every agent load for a feature that's a tight
  fit with the agent record. YAGNI until a second prefs domain shows
  up.

## More Information

* Existing wire taxonomy: ADR-0008 (chunk types).
* Existing UI hook: `hooks/useMessageFilters.ts`.
* Existing persistence column: `messages.category` (see `api/types.ts`
  `Message` interface).
* Follow-up (out of scope): expose a per-channel CSS class on
  rendered bubbles so users can re-skin channels via the theme
  system without forking `MessageBubble`.
