---
status: accepted
date: 2026-06-02
deciders: andwu, claude
---

# Split lib/tools/atlassian.ts (3,130 LOC) into a directory of focused modules

## Context and Problem Statement

`lib/tools/atlassian.ts` had grown to **3,130 lines** containing **44 LangChain tools** plus their shared auth + helpers. The bloat audit flagged it as the single biggest file in `lib/tools` (31% of `lib/tools` LOC) and the obvious split candidate. Concrete pain:

- Navigating to a single tool required scrolling past dozens of unrelated ones.
- Adding a new tool meant scrolling to the right "section" (marked by `// ── Jira agile tools ──`) and hoping the helpers it needed were declared above it.
- Onboarding readers couldn't see the file's structure without a TOC search.
- Code review of any single change meant loading the whole file into context.

## Decision Drivers

* **Per-file weight goes down.** No tool's logic crosses the new boundary; each tool's surface (schema, handler, response shape) lives in one place readable end-to-end.
* **No behavioural change.** Same tools, same registrations, same exports. Sibling modules (`lib/documents/remote/jira.ts`, `confluence.ts`) and tests import `_atlassianFetch` / pure helpers — those imports must keep working.
* **Don't break test imports.** Five test files (`atlassian.test.ts`, `atlassian-agile.test.ts`, `atlassian-confluence-gaps.test.ts`, `atlassian-issue-extras.test.ts`, `atlassian-project-meta.test.ts`) import internals through `@/lib/tools/atlassian`. The split must keep that path resolving.
* **Single registration site.** The `registerTools` calls have to fire exactly once per category, so the entry point is responsible for the union list.

## Considered Options

* **(A) Split inline by separator comments only.** No real change.
* **(B) Move tools into a `lib/tools/atlassian/` directory and rename the entry to `index.ts`.** Cleanest filesystem layout but breaks `import "./atlassian"` if anything resolves the file before the directory.
* **(C) Move tools into `lib/tools/atlassian/` and keep `lib/tools/atlassian.ts` as a thin re-export shim.** Same logical result as (B); existing imports flow through the file unchanged.

## Decision Outcome

Chosen: **(C) Directory + thin shim**.

Layout:

```
lib/tools/atlassian.ts                — entry point: re-exports + registerTools
lib/tools/atlassian/
  ├── _auth.ts          — AtlassianAuth, resolveAuth, authHeader, atlassianFetch
  ├── _helpers.ts       — body / space-id / field-id helpers, ADF flatten,
  │                       resolveCustomFieldNames, extractFieldValue,
  │                       confluenceTextToStorage, parseV2NextCursor
  ├── jira.ts           — issue tools (search, get, create, update, comment,
  │                       transition, link, bulk, attach, delete) — 881 LOC
  ├── jira-agile.ts     — boards, sprints, backlog, rank — 416 LOC
  ├── jira-extras.ts    — comments CRUD, worklogs, attachments,
  │                       changelog — 307 LOC
  ├── jira-meta.ts      — projects, versions, components, generic enums — 338
  └── confluence.ts     — search/get/list pages + spaces, comments, labels,
                          attachments, v2 gap-fillers — 878 LOC
```

The `_`-prefix on `_auth.ts` and `_helpers.ts` follows the existing convention (the file uses `_resolveAtlassianAuth` / `_atlassianFetch` for sibling-module accessors). Both files are sibling-imported from the tool files; nothing outside this directory should reach them — the shim re-exports only the public surface (the public-named helpers, never the privates).

### Consequences

* Good — biggest file dropped from 3,130 LOC to 881 LOC (jira.ts). Every tool is reachable in 2-3 levels of file navigation.
* Good — no test changes required. Every existing `import { ... } from "@/lib/tools/atlassian"` keeps working through the shim.
* Good — sibling modules (`lib/documents/remote/jira.ts`, `confluence.ts`) keep importing `_atlassianFetch` from `@/lib/tools/atlassian` unchanged.
* Good — the `registerTools` calls stay in the shim — adding a new tool to a sub-module requires updating the shim's import + the registration list. That coupling is intentional: it's a one-line addition vs. distributed registration which would scatter tool-discovery state.
* Bad — total LOC grew slightly (3,130 → 3,360) due to per-file headers and re-export blocks. That's the cost of making each file standalone-readable.
* Bad — sub-module files now have to re-import the helpers they used to share inline. Mitigated: imports are explicit and grep-able.

## Pros and Cons of the Options

### (C) Directory + thin shim (chosen)

* Good — preserves every existing import path. Zero churn at call sites.
* Good — clear separation of public surface (shim exports) from private helpers (`_`-prefixed files).
* Good — adding a tool: edit the right sub-module + add 2 lines to the shim (import + register). Adding a new sub-module: 3 changes to the shim.
* Neutral — the shim is 222 lines of mostly imports/exports. Boring but explicit.

### (B) Directory + rename entry to index.ts

* Good — slightly cleaner filesystem.
* Bad — would have to update `lib/tools/builtins.ts`'s `import "./atlassian"` and possibly other path-style imports.
* Bad — Node's module resolution prefers files over directories when both exist; renaming requires deleting the file first, which the git diff makes uglier.

### (A) Comment-only split

* Good — no work.
* Bad — the audit's whole point was that comment separators don't help navigation when the file is 3000 lines long.

## Implementation notes

* **No tool logic was modified.** Every `tool(...)` call carries the same `name`, `description`, `schema`, and handler body it had before. Verified by running the full 1,139-test suite (passes unchanged).
* **Private helpers became `export`s.** Functions that were file-local (`resolveBody`, `resolveSpaceId`, `loadJiraFields`, `coerceItem`, `stripHtml`, `textToADF`, `simplifyADF`) are now `export`ed from `_helpers.ts` because tools in different files import them. The naming convention (`_`-prefixed file) signals "internal to this directory."
* **`atlassianFetch` (private) is now `export`ed** so tool sub-modules can call it. The public `_atlassianFetch` re-export from the shim is unchanged for sibling-module callers.
* **Test files unchanged.** All five `atlassian*.test.ts` import via `@/lib/tools/atlassian` — the shim handles them.
* **Shim's `registerTools` calls** — the canonical lists move untouched into the shim. The shim imports each tool from its sub-module file, then re-exports it (so external `import { jiraSearchTool } from "@/lib/tools/atlassian"` still works) and registers it.

## Cross-references

ADR-0050 (centralised error vocabulary, `_helpers.ts` + `_auth.ts` consume it). The bloat-audit report (the source of this split's prioritisation).
