---
status: accepted
date: 2026-06-05
deciders: Andrew Wu
---

# Declare a public API surface for the npm package

## Context and Problem Statement

`@circuitwall/jarela` is published as an npm package and consumed by
brand overlays (e.g. an internal vClaw fork) and — increasingly — by
external plugin authors writing `~/.jarela/providers/*.cjs` and
`~/.jarela/tools/*.cjs` plugins. Until now there was no formally
declared public surface: every path under `lib/`, `app/`, `components/`,
etc. was implicitly importable. Any internal refactor risked silently
breaking unknown downstream consumers, and we had no rule for how
breaking changes propagate to versioning.

This is a 1.0-readiness gap. Without a contract, there is no clean way
to bump major versions, no deprecation policy, and no mental model for
plugin authors of "what's safe to depend on."

## Decision Drivers

* 1.0-readiness: must commit to a stable surface and the rules for
  changing it.
* External plugin authors should be able to read one place to know what
  they can safely import.
* The realistic consumer pattern is a small set of TypeScript types
  (provider/tool contracts) — the rest of the codebase is application
  internals.
* Pre-1.0 carve-out: don't break overlays that may currently reach into
  private paths. Need a transition window.

## Considered Options

* **Option A — Full lockdown.** Declare an explicit `exports` map with
  no wildcard fallback. Anything not listed is unreachable from outside
  the package.
* **Option B — Tag-and-doc only, no `exports` field.** Add JSDoc
  `@public` / `@internal` markers and document the contract in
  CONTRIBUTING.md, but leave package.json open.
* **Option C — Explicit `exports` map plus a `./*` wildcard fallback.**
  List the contract paths explicitly; allow access to everything else
  during the pre-1.0 transition; remove the wildcard at 1.0.

## Decision Outcome

Chosen option: **C**, because it captures intent now (the explicit
list) without immediately breaking any downstream consumer that happens
to reach into a private path. The deprecation policy in CONTRIBUTING.md
makes the future tightening predictable, and ADR-0061 itself signals
that the wildcard is a transition mechanism.

The contract paths are:

| Subpath                      | What it exposes                                                              |
|------------------------------|------------------------------------------------------------------------------|
| `./lib/providers/types`      | `ModelProvider` and friends — the contract external LLM providers conform to |
| `./lib/tools/types`          | `OpenAITool`, `ToolContext`, `InvokeMessage`, etc. — the tool authoring API  |
| `./lib/tools/registry`       | `registerTools`, `ToolCategory`, `Capability`, `ToolGroup`, `BuiltinCategory`|
| `./lib/mcp/registry`         | `RegistryEntry`, `RegistryVariable`, `applyVariables`                        |
| `./package.json`             | Required by tools that read the package metadata                             |

The HTTP API has its own public surface tagged with `@public` JSDoc on
each `app/api/v1/*/route.ts` file. The full reference lives in
[docs/api.md](../api.md).

### Consequences

* Good, because plugin authors and overlay maintainers now have one
  authoritative table to check before depending on a path.
* Good, because future refactors of internals (anything reachable only
  via the wildcard) are unambiguously non-breaking.
* Good, because the deprecation policy makes the post-1.0 contract
  enforceable: deprecate in `0.X.0`, remove no earlier than `0.(X+1).0`.
* Bad, because the wildcard fallback temporarily blunts the contract;
  some consumers may form dependencies on private paths that we'd then
  have to deprecate gracefully at 1.0.
* Bad, because TypeScript files (`.ts`) ship raw in the published
  tarball — consumers who want to import the contract types need their
  own TS toolchain. This is consistent with current behaviour, but
  worth flagging.

## Pros and Cons of the Options

### A — Full lockdown

* Good, because zero ambiguity.
* Bad, because anyone currently reaching into `lib/...` from outside
  the package breaks immediately. Pre-1.0 we shouldn't pay that cost.

### B — Tag-and-doc only, no `exports` field

* Good, because lowest-friction.
* Bad, because there is no machine-readable contract — Node's resolver
  can't tell `lib/providers/types` (public) from `lib/agents/run-thread`
  (private). Plugin authors and overlays can drift unintentionally.

### C — Explicit `exports` map plus `./*` wildcard fallback (chosen)

* Good, because captures intent today and matches future intent (the
  list is the post-1.0 surface; wildcard is removed at 1.0).
* Good, because it does not break any current consumer.
* Neutral, because the contract is partially aspirational until 1.0
  removes the wildcard — but that's exactly what the
  deprecation-policy + CHANGELOG entry are for.

## Follow-ups

* Remove the `./*` wildcard at the 1.0 cut.
* Consider adding `types` field or `.d.ts` emit if external TS
  consumers materialize.
* Watch for inadvertent consumers of private paths via build tooling
  (Next.js standalone, etc.) — they should not be affected since they
  bundle internally, but worth verifying when we tighten at 1.0.
