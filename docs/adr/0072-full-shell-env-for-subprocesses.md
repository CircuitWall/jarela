---
status: "accepted"
date: 2026-08-14
deciders: example-user
consulted:
informed:
---

# Give every Jarela-spawned subprocess the user's full shell environment

## Context and Problem Statement

`claude_delegate` ([lib/tools/claude-delegate.ts](../../lib/tools/claude-delegate.ts)) spawns the local `claude` CLI, which itself shells out to other CLIs the user has configured — `gh`, `aws`, `jira`, internal tooling, etc. Those CLIs read their credentials straight from the environment. Under ADR-0016 / ADR-0034, Jarela only ever forwards an explicit, code-owned allowlist of env vars into subprocess env (`getInjectedSubprocessEnv()`) plus whatever happens to be in Jarela's own `process.env`. A var that lives only in the user's `.zshrc`/`.bashrc` and isn't one of the ~10 allowlisted credential names — which covers most CLI tool credentials — never reaches the delegated `claude` process, or any other subprocess, when Jarela runs as a background service (launchd/systemd) instead of from an interactive terminal.

The allowlist was deliberately narrow (ADR-0034: "Don't expand the trust surface"). Widening it to cover every CLI a user might have configured isn't tractable — the point of an allowlist is that someone curates it.

## Decision Drivers

* `claude_delegate`'s value proposition is running the `claude` CLI with the same tool access the user has from a terminal — that means the same credentials, for tools we can't enumerate in advance.
* The existing allowlist model (ADR-0016/0034) is fine for the ~10 known integration credentials Jarela itself talks to, but wrong for "whatever CLI tool the user happens to have configured."
* CLAUDE.md invariants: no new daemon, single Next.js process, no persistent ad-hoc state outside `JARELA_DB_DIR`.
* Security: broadening from an allowlist to "everything" measurably increases blast radius — any subprocess (including a stdio MCP child from a third-party server, or an `exec`/`terminal` tool call an agent decides to run) can now see secrets unrelated to its job (AWS keys, JFrog tokens, etc.), not just Anthropic auth. This is the same trade-off ADR-0034 made for the allowlisted set; this ADR makes it for everything.

## Considered Options

**Scope — which subprocesses get the full env:**
* **(S1) Only `claude_delegate`'s spawn.** Smallest blast radius; matches the motivating problem exactly.
* **(S2) Every subprocess Jarela spawns** (exec, terminal, claude_delegate, MCP stdio children) — chosen. Consistent with the existing precedent (`getInjectedSubprocessEnv()` already reaches all of these per ADR-0034) and avoids a second, divergent env-resolution path just for one tool.

**Freshness — how "restart to get new env vars" works:**
* **(F1) In-memory cache, refreshed by the existing "Sync from environment" button or by an app restart** — chosen. No new persistence, no new UI; reuses the boot-time `runEnvSyncOnce()` path from ADR-0016.
* **(F2) A dedicated "restart app" UI action.** Extra surface for a behavior a process restart already provides for free.

## Decision Outcome

Chosen: **S2 + F1**.

* `lib/env/discover.ts` gains `discoverAllShellEnv()` — a full, unfiltered probe (`env -0` on macOS/Linux inside `$SHELL -ic`, full `[Environment]::GetEnvironmentVariables('User')` enumeration on Windows), replacing the allowlist-scoped `discoverEnvVars()` this ADR removes as dead code.
* `lib/tools/subprocess-env.ts` gains a module-level cache (`setFullShellEnv`/`getFullShellEnv`), merged into `resolveSubprocessEnv()`'s existing precedence chain, below `getInjectedSubprocessEnv()` and any caller-supplied `options.env` — the encrypted store and explicit overrides still win.
* `lib/mcp/client.ts`'s `buildSubprocessEnv` merges the same cache in at the equivalent layer, still respecting `SCRUBBED_VARS`.
* `lib/env/sync.ts`'s `runSync(apply=true)` — used by both the boot-time fire-and-forget sync and the manual "Sync from environment" button — probes the full env once and calls `setFullShellEnv()`, in addition to its existing allowlist-scoped DB-write flow (which is unchanged; the full probe is a superset, so the existing candidate-evaluation logic just indexes into it). `previewEnvSync()` (non-mutating) does not touch the cache.

### Consequences

* Good, because `claude_delegate` (and any other subprocess) sees the same credentials a real terminal would, without us maintaining a list of every CLI tool a user might have configured.
* Good, because no new persistence or UI surface — "restart to refresh" falls out of the existing boot-sync path for free.
* Bad, because the trust surface widens further than ADR-0034: an `exec`/`terminal` tool call, or a third-party stdio MCP server, now also sees the user's full shell env (AWS/JFrog/Jira tokens, etc.), not just the vars Jarela's own integrations need. This was an explicit choice (confirmed with the user) over the narrower alternative of scoping it to `claude_delegate` only.
* Bad, because the full-env probe is a second, larger payload than the allowlist probe — mitigated by the same 4 s timeout and graceful fallback pattern from ADR-0016.

## More Information

* [ADR-0016 — env-sync from shell rc](0016-env-sync-from-shell-rc.md) — the boot/button trigger points and per-field provenance this ADR reuses unchanged.
* [ADR-0034 — customizable env allowlist + subprocess injection](0034-customizable-env-allowlist.md) — the allowlist-and-injection model this ADR extends from "known credentials" to "everything," for the subprocess-env path only. The credential-store write path (`ENV_ALLOWLIST` → `putMemory`) is untouched.
* [ADR-0071 — Claude Code delegation tool](0071-claude-code-delegation-tool.md) — the motivating consumer (`claude_delegate`).
