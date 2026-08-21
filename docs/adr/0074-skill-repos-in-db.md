---
status: "accepted"
date: 2026-08-21
deciders: andwu
consulted:
informed:
---

# Skill repos are DB-backed rows, not a `JARELA_SKILLS_DIR` env var

## Context and Problem Statement

Skills (`lib/skills/index.ts`) only ever supported one external directory, configured via the `JARELA_SKILLS_DIR` env var (through the generic `ENV_SCHEMA` / env-overrides mechanism, ADR-0060). A same-day change taught it to accept several directories by splitting that one string on the OS path-list delimiter (PATH-style). Every other multi-item, user-managed collection in Jarela — MCP servers (`mcp_servers` table), document sources (`document_sources` table, ADR-0024) — is instead a DB table with a REST CRUD surface and (for document sources) agent tools, not a delimited env var. Skill repos are the odd one out, and the delimited-string shape has no room for per-repo metadata (a label, enabled/disabled, which one is writable) without inventing a second ad-hoc syntax on top of it.

## Decision Drivers

* Consistency: a collection of user-managed filesystem/network locations should look like `document_sources`/`mcp_servers`, not a bespoke env var, so anyone who has read one of those stores already understands this one.
* Per-repo metadata (label, enabled toggle, which repo is writable) doesn't fit cleanly into a single delimited string.
* CLAUDE.md: favor explicit, boring, predictable designs; no half-finished implementations — the just-added delimited-env-var form was never released (still under `[Unreleased]`), so there is no back-compat burden to carry forward.
* This is a persistence-schema change under `~/.jarela` (new table), which is an explicit ADR trigger in this repo's CLAUDE.md.

## Considered Options

* **(A) Keep the delimited `JARELA_SKILLS_DIR` env var** (the just-added change) — zero extra plumbing, but inconsistent with every other multi-item store and has no room to grow (label/enabled/writable) without a second syntax.
* **(B) DB-backed `skill_repos` table + REST CRUD**, mirroring `document_sources` — a small `lib/stores/skill-repos.ts` (list/get/create/update/delete), a `skill_repos` table (`id, path, label, writable, enabled, created_at, updated_at`), and `app/api/v1/skills/repos[/​[id]]` routes.
* **(C) Both** — DB is authoritative, env var seeds the DB once at first boot then is ignored — smooths a hypothetical existing deployment but adds a one-time migration path for a feature that was never shipped.

## Decision Outcome

Chosen: **(B) DB-backed `skill_repos` table**, replacing the env var outright (no seed/migration path — option C's problem doesn't exist yet since the env var never reached a release).

* `lib/stores/skill-repos.ts` owns the table: `path` is `UNIQUE`; exactly zero or one row may have `writable=1` (enforced by the store — setting a new writable repo clears the flag on any previous one); scan/override order is `created_at ASC`, so a later-added repo's skill wins over an earlier repo's (and over built-ins) on id collision, matching the delimited-string behavior it replaces.
* `lib/skills/index.ts` reads repos from the store instead of `getConfig().skillsDirs`; writes/deletes always target the one `writable=1` repo (or fail with "not configured" if none is set, same failure shape as before).
* `app/api/v1/skills/repos/route.ts` (GET list, POST create) and `.../repos/[id]/route.ts` (GET, PATCH, DELETE) mirror `app/api/v1/documents/sources` — validate the path exists and is a directory, 409 on duplicate path.
* `JARELA_SKILLS_DIR` is removed from `ENV_SCHEMA` entirely.

### Consequences

* Good — one mental model for "a user-managed list of external things": MCP servers, document sources, and now skill repos are all a DB table + REST CRUD, not a mix of tables and delimited env vars.
* Good — per-repo `label`/`enabled`/`writable` are first-class columns now, not a second syntax bolted onto a path string.
* Good — no restart required to add/remove a repo (the old env var was `requiresRestart: true`); the loader reads the store live, same as it already does for document sources.
* Bad — anyone who had already set the delimited `JARELA_SKILLS_DIR` (from the same-day change this supersedes) loses that config silently on upgrade; accepted because that change was never released.
* Neutral — skill repos still have no settings-UI page (same as before this change); only the REST surface exists. A UI is a separate follow-up if wanted, same as it would be for the previous env-var form.

## More Information

* [ADR-0024 — Document RAG](0024-document-rag.md) — the `document_sources` table this mirrors.
* [ADR-0060 — env overrides and config schema](0060-env-overrides-and-config-schema.md) — the mechanism `JARELA_SKILLS_DIR` used and now no longer needs.
* [lib/stores/mcp-servers.ts](../../lib/stores/mcp-servers.ts) — the other close analog (single-writer-flag idea borrowed conceptually, though MCP servers don't need a "writable" concept).
