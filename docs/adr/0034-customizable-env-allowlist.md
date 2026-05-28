---
status: "accepted"
date: 2026-05-28
deciders: jarela maintainers
---

# Customizable env-sync allowlist + Anthropic integration + subprocess injection

## Context and Problem Statement

Today's env-sync ([lib/env/allowlist.ts](../../lib/env/allowlist.ts)) uses a
hardcoded list of credential env vars that get pulled from the user's shell
rc into the encrypted integration store. The list does not cover Anthropic
(the primary LLM provider), and users whose dotfiles use non-canonical names
(e.g. `MY_GH_PAT` instead of `GITHUB_TOKEN`) cannot benefit from sync. A
related gap: when Jarela is installed as a service (launchd, systemd, brew
services) the launching environment has no shell exports, so `local_exec`
shells and stdio MCP children see none of those credentials — even though
the encrypted store has them.

## Decision Drivers

* **Service-mode installs need credentials in subprocesses.** A user who
  ran env-sync once from a shell expects `GITHUB_TOKEN` to be available to
  shell tools on the next service-mode boot, even though the launching
  environment is empty.
* **Dotfile naming variance.** Different machines and roles use different
  names for the same secret (`GH_TOKEN` vs `GITHUB_TOKEN`, `JIRA_TOKEN`
  vs `ATLASSIAN_API_TOKEN`, `MY_ANT_KEY` vs `ANTHROPIC_API_KEY`).
* **Don't expand the trust surface.** Env-sync writes into the encrypted
  integration store. Letting users invent new `(integration, field)`
  targets at runtime would mean writing rc values into rows with no
  schema, no provider wiring, and no UI representation.
* **Anthropic should be first-class.** It's the primary LLM provider but
  has no integration card today; agent code reads `process.env`
  directly, which means service-mode installs can't ever use Claude.

## Considered Options

* **(A) Free-form allowlist editor** — let users define arbitrary
  `(envVarName → integration:field)` mappings. Most flexible.
* **(B) Override env-var names only** — keep the `(integration, field)`
  targets fixed in code; let users add additional alias names per row.
* **(C) Status quo** — keep the allowlist hardcoded.

For the subprocess problem we considered:

* **(P1) Inherit `process.env` only** (status quo). Loses credentials in
  service mode.
* **(P2) Scrub env-sync-managed names from subprocess env.** Defense-in-depth
  against accidental subprocess leaks, but useless when the subprocess
  legitimately needs the value.
* **(P3) Inject store values into subprocess env.** Subprocess sees the
  store as canonical. Symmetric with how the rest of the codebase already
  reads the store (`getIntegrationRaw`).

## Decision Outcome

**Chosen options: B + P3.**

* Add `getEffectiveAllowlist()` in
  [lib/env/allowlist.ts](../../lib/env/allowlist.ts) that merges the
  hardcoded `ENV_ALLOWLIST` defaults with per-`(integration, field)`
  override rows stored in `memory_store` namespace
  `"env_allowlist_overrides"`. Defaults always remain — overrides are
  additive. The override target validates against `INTEGRATIONS`, so the
  schema can never drift.
* Surface this via `GET/PUT /api/v1/env-sync/allowlist` and a small
  inline editor in the Integrations panel.
* Add an `anthropic` integration card and wire the Anthropic provider's
  fallback chain to read the store between `params.api_key` and
  `process.env.ANTHROPIC_API_KEY`. Add `ANTHROPIC_API_KEY` to the
  hardcoded defaults.
* Add `getInjectedSubprocessEnv()` that renders the encrypted store back
  into `Record<envVarName, value>` (defaults + override aliases). Wire
  it into both [lib/mcp/client.ts](../../lib/mcp/client.ts) `buildSubprocessEnv`
  and [lib/tools/exec.ts](../../lib/tools/exec.ts) `runLocalCommand`,
  layered between `process.env` and the explicit per-call/per-server env
  override so the explicit override always wins.

### Consequences

* Good, because service-mode installs work end-to-end: the user runs
  env-sync once from a shell, the store fills, and afterwards every
  subprocess sees the canonical names regardless of how Jarela is
  launched.
* Good, because users with non-canonical dotfile names can sync without
  asking us to merge a PR — they add an alias in the panel and the next
  sync picks it up.
* Good, because the Anthropic key now has a UI surface and a sync path
  symmetric with `google` / `github`.
* Bad, because subprocess injection means a stored secret reaches every
  shell tool invocation and every stdio MCP child. This is intentional
  (otherwise service-mode installs are broken), but it is a behavioral
  change versus the previous model where only the host process saw
  these values. Per-call mitigations remain (`local_exec`'s `env`
  parameter and MCP `spec.env` still win, so callers can override or
  unset on a case-by-case basis).
* Bad, because allowing users to extend the allowlist creates a small
  ongoing maintenance surface — overrides referencing fields that get
  renamed will be silently ignored. Acceptable: the next time the user
  opens the panel they see the row no longer applies and can fix it.

## Pros and Cons of the Options

### B (override env-var names only)

* Good, because the trust surface is unchanged: rc values still only
  flow into rows with a schema, a provider wiring, and a UI card.
* Good, because the implementation is one merge step at sync time and
  one validation step at write time.
* Neutral, because users who genuinely need a *new* integration still
  have to PR one upstream — not regressed but also not addressed.
* Bad, because the UX has to explain what the user can and cannot edit.

### A (free-form allowlist)

* Good, because no PR ever needed to add a new mapping.
* Bad, because it lets a user write arbitrary rc values into the
  encrypted store under arbitrary keys, with no guard rails. Easy to
  misuse and easy to lose track of.

### P3 (subprocess injection) vs P2 (scrub)

* P3 is good because credentials follow the agent — exactly what the
  service-mode user expects.
* P3 is bad because subprocesses see those credentials by default. The
  caller-side `env` override (per-call for exec, per-server for MCP)
  provides the escape hatch when a specific child should not see them.
* P2 is good for defense-in-depth but breaks the fundamental use case
  of running tools that need these credentials. Rejected.

## More Information

* Implementation: this PR adds `lib/env/allowlist.ts` overrides,
  `app/api/v1/env-sync/allowlist/route.ts`, and the
  `EnvAliasEditor` component.
* Future work: an explicit "scrub for this child" flag on MCP server
  specs for users who want to keep a stdio child sandboxed from
  env-sync values. Not in this PR.
