---
status: accepted
date: 2026-05-22
deciders: andwu
consulted:
informed:
---

# Type-aware routing for the Jira Align tool surface

## Context and Problem Statement

[ADR-0019](0019-jira-align-tool.md) shipped a native Jira Align tool
that assumed a generic work-item collection at
`/rest/align/api/2/items/{id}`. That endpoint does **not exist** in
Jira Align REST v2. Every read/write/delete therefore came back as a
bare `404` (empty body — Atlassian's "route not found" signature, not
an auth failure):

```json
{ "error": "Jira Align 404: ", "url": "https://visa.jiraalign.com/rest/align/api/2/items/179843" }
```

The actual API splits work items by *type* — each type lives at its
own collection: `/epics`, `/capabilities`, `/features`, `/stories`,
`/themes`, `/tasks`, `/defects`, `/objectives`. There is no
cross-type item route. Hierarchy walking is also not exposed via a
sub-resource: children are queried by filtering the child collection
on `parentId`.

We need to fix the routing without changing the per-tool permission
UX users already have configured in AgentEditor.

## Decision Drivers

* **Correctness** — every existing tool currently 404s, so fixing
  routing trumps everything else.
* **Preserve the per-op permission gate** — the eight tool *names*
  (`jira_align_get_item`, `…_search_items`, `…_create_item`, …) ship
  in agent configs that users may have already saved. Renaming would
  break those configs silently.
* **Match how the API actually works**, not how we wished it worked.
  The agent has to know *which type* it's talking to anyway (`epic`,
  `feature`, `story`); making that explicit in the tool schema is
  honest about the underlying surface.
* **Keep the integrations test endpoint** in
  `app/api/v1/integrations/[name]/test/route.ts` working — it
  already probes `/programs?limit=1`, which is a real endpoint and
  unaffected by this fix.

## Considered Options

* **A — Type-aware schemas.** Every tool gains a required `type` arg
  (zod enum over the eight known JA work-item types). The handler
  maps `type → collection segment` (`epic → epics`,
  `capability → capabilities`, `story → stories` — JA pluralization
  isn't a regex) and routes to `/rest/align/api/2/{collection}/{id}`.
  Keeps tool names. `jira_align_get_item_children` becomes
  `jira_align_list_children` since the API has no `/children`
  sub-route — children are a `parentId` filter on the child
  collection, so the tool now requires both `parent_id` and
  `child_type`.
* **B — Probe each collection until one returns 200.** Hide the type
  from the agent. Costs up to 8 round-trips per `get_item`; muddles
  error semantics (was the 404 a real miss or a wrong-type guess?).
* **C — Add an in-process index from `id → type` populated lazily by
  searching every collection, then route through it.** Same wasted
  round-trips, plus a cache invalidation problem we don't need.
* **D — Drop the tool and document JA as MCP-only.** Reverses the
  ADR-0019 decision against MCP and reintroduces the corporate-network
  problem `atlassian.ts` was created to dodge.

## Decision Outcome

Chosen option: **A — type-aware schemas.**

The agent already knows the type when it forms a request (it's
visible in any item id it sees from a previous search), so making
`type` explicit costs the LLM nothing and gives us a deterministic
URL. Probing and lazy indexing both add latency and obscure failures
without buying anything for the user. Dropping native support
contradicts ADR-0019's still-valid driver of avoiding MCP installs on
locked-down corporate networks.

### Consequences

* **Good** — every tool now hits a real endpoint. The 404 the user
  saw on `/items/179843` becomes a `200` against
  `/{type}s/179843` (or a real `404` if the id genuinely doesn't
  exist in that collection).
* **Good** — tool *names* are unchanged, so saved AgentEditor
  configs and `ToolPolicy.allow/deny` lists keep working. Only one
  rename: `jira_align_get_item_children` → `jira_align_list_children`
  to reflect that it's a sibling-collection filter, not a sub-route
  walk. Anyone who had the old name in an allowlist will lose access
  to the rewritten tool until they re-check the box, but the alternate
  was leaving a tool that had never worked.
* **Good** — search uses OData `$filter` (the documented JA v2 query
  language) so callers can append custom-field predicates via a
  `filter` arg without us having to model every field.
* **Good** — the relative-date shorthand (`updated_since='-7d'`)
  carries over from the Jira Cloud tool, normalized client-side to an
  ISO timestamp before going into `$filter`.
* **Bad** — agents have to supply `type` for every call. If they get
  it wrong (asking for `feature` when the id is actually a `story`),
  they get a clean 404 from the typed collection. Acceptable: it's
  the same failure mode as Jira Cloud's "wrong project key".
* **Bad** — hierarchy walks are now one call per level instead of a
  single `_get_item_children` round-trip. The old tree-walker
  pretended to descend N levels but was always going to fail on the
  first hop because `/items/{id}/children` doesn't exist either.
* **Bad** — comments are kept at `/{type}s/{id}/comments` based on
  the public docs, but JA instances vary on whether comments are
  exposed as a sub-resource on every type. The tool's docstring
  flags this; if it 404s on a given instance, the user can disable
  the tool individually.

## Auth contract

Unchanged from ADR-0019:

```
Resolution order:
  1. Env: JIRA_ALIGN_URL, JIRA_ALIGN_TOKEN
  2. Memory store: namespace="integrations", key="jira_align",
     value={ url, api_token }
```

## Tool surface — v2

| Tool                              | Read | Write | Default in AgentEditor |
|-----------------------------------|:----:|:-----:|:----------------------:|
| `jira_align_get_item`             |  ✓   |       | enabled                |
| `jira_align_search_items`         |  ✓   |       | enabled                |
| `jira_align_list_children`        |  ✓   |       | enabled                |
| `jira_align_create_item`          |      |   ✓   | enabled                |
| `jira_align_update_item`          |      |   ✓   | enabled                |
| `jira_align_transition_item`      |      |   ✓   | enabled                |
| `jira_align_add_comment`          |      |   ✓   | enabled                |
| `jira_align_delete_item`          |      |   ✓   | **disabled** (opt-in)  |

Every tool now requires a `type` argument (zod enum over
`epic | capability | feature | story | theme | task | defect | objective`).
The destructive `delete` still requires `confirm === item_id`
(unchanged two-arg gate from ADR-0019).

## Out of scope

Same exclusions as ADR-0019 (custom-field translation, bulk import,
multi-instance, webhook subscription). Plus:

* **Cross-type id lookup.** If the user only has a numeric id and
  doesn't know the type, the agent must search per type — no
  unified "find by id" tool. Adding one would require either probing
  all collections (option B above, rejected) or a server-side index.

## More Information

* Tool: `lib/tools/jira-align.ts`.
* Registration: `lib/tools/index.ts` (`JiraAlign` category, `Work` group).
* Integration test endpoint: unchanged at
  `app/api/v1/integrations/[name]/test/route.ts` (probes `/programs`).
* Supersedes: [ADR-0019](0019-jira-align-tool.md).
* Reference: [JA REST API 2.0 — Getting started](https://help.jiraalign.com/hc/en-us/articles/360045371954-Getting-started-with-the-REST-API-2-0)
  and [API 2.0 query syntax](https://help.jiraalign.com/hc/en-us/articles/360060894632-API-2-0-query-syntax).
