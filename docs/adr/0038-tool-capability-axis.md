---
status: "proposed"
date: 2026-06-01
deciders: example-user
---

# ADR-0038: Tool capability axis (read / write / execute)

## Context and Problem Statement

Today the [tool registry](../../lib/tools/registry.ts) tags each built-in
tool with a single dimension — `ToolCategory` (`Memory`, `Files`, `Web`,
`Mail`, `Atlassian`, …). That dimension is *topical* and exists to group
tools in the Agent editor sidebar; it deliberately says nothing about what
a tool *does*. `Files` mixes `file_read` (no side effects) with
`file_delete` (destructive). `Mail` mixes `gmail_search` (read-only) with
`gmail_create_draft` (touches an external service). `Schedule` mixes
listing scheduled tasks with creating new ones.

We want a second, orthogonal *capability* dimension so the system can
reason about safety class — not just topic. The immediate consumer is a
planned per-capability approval gate ("essential mode": read = always
allowed, write = optionally gated, execute = always gated). Other
likely consumers: UI badges in the Agent editor, audit log buckets, the
ADR-0037 output validator's citation rules, future capability-scoped
permissions for delegated agents.

The actual approval gate is out of scope for this ADR — it depends on
the capability data being correct and complete first. This change adds
the dimension and classifies every built-in tool. The gate lands in a
follow-up ADR once the data is settled.

## Decision Drivers

* Safety class is orthogonal to topic. `gmail_search` and
  `gmail_create_draft` belong in the same sidebar group but are nowhere
  near each other on a risk scale.
* Existing `registerTools(category, tools)` callers all sit at the bottom
  of their tool file with the full tool list visible — the migration
  cost is one call per file (or two, where capabilities split).
* Per-tool, not per-file, granularity. Several tool files (memory, files,
  schedule, atlassian, github) genuinely contain a mix of read + write
  + execute tools. A per-file tag would force a misclassification.
* The capability values must be a closed enum so consumers can switch on
  them exhaustively. Three values cover every observed tool; we resist
  adding more (no "network", "destructive", "external" sub-flavors) to
  keep approval policies simple to reason about.

## Considered Options

1. **Add a `Capability` enum and require it on every `registerTools` call
   (this ADR).** New signature:
   `registerTools(category, capability, tools)`. Files with mixed
   capabilities make multiple calls — three lines instead of one.
   Closed-enum, no defaults, no escape hatches.
2. **Per-tool inline annotation via `tool({ ... metadata })`.** Bake the
   capability into each tool's own definition rather than the registry
   call. More local, but every wrapper today (`tool(handler, schema)`)
   would gain a third positional arg or shift to an options-bag pattern.
   Bigger churn; loses the property that registration today is a single
   bottom-of-file call.
3. **Heuristic classifier from the tool name and zod schema.** Look for
   `_create_`, `_delete_`, `_send_`, etc. in the name; treat tools whose
   schema mutates required external state as execute. Zero migration
   cost, but the heuristic is opaque and wrong on edge cases
   (`memory_list` is read but `documents_list_sources` is also read while
   `documents_add_local_source` is write — the names give no consistent
   signal). Bad data tax for a mediocre savings.
4. **Three separate `registerReadTools` / `registerWriteTools` /
   `registerExecuteTools` functions.** Same effect as option 1 but
   without an enum value to switch on at call sites. Slightly more
   ergonomic for the common single-capability file (one call, no enum),
   slightly worse for mixed-capability files (one call per bucket
   instead of one call with the enum). Net: marginal trade. Option 1
   keeps the enum value as a first-class data point in the registry,
   which is what consumers downstream will want.

## Decision Outcome

Chosen option: **1**, because:

* The registry is already the single source of truth for tool metadata.
  A second axis there is a natural extension, not a new system.
* The migration is mechanical and bounded: one call per `registerTools`
  site, each call gets a capability literal. Mixed-capability files split
  into 2–3 calls. ~22 files affected.
* Closed enum + required argument means a new tool *cannot* land
  uncategorised — the type-checker forces classification. No defaults,
  no `?: Capability` partial typing.
* Consumers (the future approval gate, UI badges, ADR-0037 validator)
  can switch on three values exhaustively. Adding a fourth value (e.g.
  `destructive`) is a deliberate ADR-level decision, not a drift target.

## Decision details

### Capability values

```ts
export type Capability = "read" | "write" | "execute";
```

Definitions (kept tight on purpose):

* **`read`** — inspects state, does not mutate anything anywhere. Pure
  observation. Includes network GETs that don't trigger side effects on
  the remote. Examples: `memory_read`, `file_list`, `web_fetch`,
  `jira_search`, `gmail_search`, `documents_search`.
* **`write`** — mutates persisted state, local or remote. Edits a
  record. A non-power user reading the label thinks "this is changing
  data". Examples: `memory_write`, `file_write`, `schedule_task`,
  `documents_add_local_source`, `propose_config_change`,
  `jira_create_issue`, `jira_add_comment`, `github_create_pull`,
  `gmail_create_draft`, `calendar_create_event`,
  `confluence_update_page`.
* **`execute`** — *performs an action* whose effect is more than
  editing a record: runs arbitrary code, ships a deliverable, triggers
  downstream automation, or transitions a workflow state. A non-power
  user thinks "this is doing something, not just editing". Examples:
  `local_exec`, `shell_exec`, `restart_server`, `set_env_var`,
  `generate_image`, `generate_voice`, `delegate_to_agent`,
  `jira_transitions`, `jira_align_transition_item`, `github_merge_pull`.

The water gets murky in three places, settled by these tie-breakers:

* **Local vs remote record edits.** Both are `write`. The line is
  "would the user describe this as editing data?", not "who owns the
  storage?". `jira_update_issue` and `memory_write` are both `write`.
* **Workflow transitions vs field updates.** Transitioning an issue
  (Jira `transitions`, JA `transition_item`) is `execute` — it fires
  notifications and automations and changes how the work item shows up
  to other people. Updating a description field on the same issue is
  `write`.
* **PR open/update vs PR merge.** Opening or updating a PR is `write`
  (records being edited). Merging the PR is `execute` because it
  triggers CI, deploys, and side effects nobody opted into per-merge.
* **Mail draft vs mail send.** Drafts are `write` — the user still
  controls whether they go out. A direct send (when wired) would be
  `execute`. Trash is `write` (a folder move, recoverable).

### Registry shape

```ts
export type Capability = "read" | "write" | "execute";

interface RegistryEntry {
  tool: StructuredToolInterface;
  category: BuiltinCategory;
  capability: Capability;       // NEW
  group: ToolGroup;
}

export function registerTools<T extends StructuredToolInterface>(
  category: BuiltinCategory,
  capability: Capability,        // NEW
  tools: readonly T[],
): readonly T[];

export function registeredCapability(name: string): Capability | undefined; // NEW
```

External tools (loaded from `JARELA_TOOLS_DIR`) and MCP tools default to
`execute` — they call out to user-provided code or external servers, and
without per-tool annotation we cannot prove otherwise. Users who want
finer-grained gating on extension tools can declare a capability in the
extension manifest; deferred to follow-up.

### Migration

Every `registerTools` call site updated. Files with one capability get
one call; files with mixed capabilities split:

```ts
// Before
registerTools("Memory", [memoryReadTool, memoryWriteTool, memoryListTool]);

// After
registerTools("Memory", "read",  [memoryReadTool, memoryListTool]);
registerTools("Memory", "write", [memoryWriteTool]);
```

A registry-level test asserts every registered name has a non-undefined
capability — guarantees no tool slips through during the migration.

### Out of scope

* The actual "essential mode" approval gate (the original motivating
  consumer). Lands in a separate ADR once the capability data is in
  place; consumers like the gate, UI badges, and validator coupling are
  cheap follow-ups once the data exists.
* Per-tool capability annotation for external (`JARELA_TOOLS_DIR`) and
  MCP tools. Both default to `execute` for safety; manifest support is
  follow-up work.
* Sub-flavors like `destructive` or `costly` (LLM-paid actions). The
  three-value enum is deliberately small. Add only when a consumer
  proves the distinction is load-bearing.

## Consequences

* Good — every built-in tool now carries a safety class the system can
  switch on. The future approval gate is a small wiring change, not a
  new data model.
* Good — closed-enum + required argument means uncategorised tools fail
  to compile. The type-checker enforces what the prose has been gesturing
  at for months.
* Good — separable from gating. This PR ships data; consumers ship logic.
  Each is reviewable and revertible on its own.
* Bad — touches ~22 files in one PR. Migration is mechanical but the
  diff is wide.
* Bad — defaults for external/MCP tools are conservative (`execute`).
  Some perfectly safe extension tools will be over-gated by the future
  approval mode. Mitigated by a planned manifest field.
* Neutral — minor churn for downstream forks that override
  `registerTools`. The signature change is breaking but deliberate; a
  one-line type error is preferable to a default-capability silent drift.

## More Information

* Affected files: every `lib/tools/<name>.ts` that calls `registerTools`,
  plus [lib/tools/registry.ts](../../lib/tools/registry.ts).
* Related: [ADR-0037](0037-agent-output-validator.md) (the validator's
  citation rules can later differentiate execute-tool citations from
  read-tool citations).
* Follow-ups (separate ADRs):
  * Per-capability approval mode ("essential mode") wired into the
    agent loop.
  * Capability declarations in extension/MCP tool manifests.
