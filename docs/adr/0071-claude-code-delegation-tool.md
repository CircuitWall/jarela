# 0071 – Delegate coding tasks to Claude Code as a workspace-integrated built-in tool

- Status: accepted
- Date: 2026-08-12

## Context

A Claude Code integration already exists as a separately-loaded external
`.cjs` tool (`claude-subagent.cjs` + `claude-memory-sync.cjs`, loaded per
[ADR-0013](./0013-external-extension-contract.md)'s external-tool
contract). It works — it spawns the `claude` CLI, streams `stream-json` events back,
persists a session per project directory, and round-trips memory rows
through `~/.claude/projects/<cwd>/memory/*.md` — but it has three problems
now that we're bringing the same capability in-tree:

1. **No verification loop.** The calling agent hands off a prompt and gets
   back Claude's own prose summary. It has no structured way to know what
   actually changed on disk, so it either trusts the summary blindly or has
   to re-derive the diff itself with a follow-up `local_exec("git diff")`.
2. **No safety-mode integration.** It unconditionally spawns `claude` with
   `--permission-mode bypassPermissions`. Every other execute-capability
   tool in this repo (`local_exec`, `terminal_exec`) is gated by
   `JARELA_TOOL_SAFETY` (`lib/tools/safety.ts`); this one bypassed that
   gate entirely, so setting `JARELA_TOOL_SAFETY=safe` did not, in fact,
   make Claude delegation safe.
3. **Ad-hoc persistence.** Session IDs live in a hand-rolled JSON file
   next to the external tool's own state, and memory sync round-trips
   over loopback HTTP (`fetch("http://127.0.0.1:8000/api/v1/memory")`) even
   though, once ported in-tree, it runs in the same process as
   `lib/stores/memory.ts`. This repo's convention (see root `CLAUDE.md`) is
   that all persistent state goes through `lib/db`/`lib/stores`.

Separately: we already have a `workspace_init`/`workspace_status`/
`workspace_close` family (`lib/tools/workspace.ts`) that builds the calling
agent's own understanding of a project (git state, languages, conventions)
and scopes `file_*`/`local_exec` calls to that root. Folding Claude
delegation into that family, instead of shipping it as a standalone
"Agent"-category black box, means the agent already has a model of the
codebase before delegating, and can be hand a structured diff afterward
instead of Claude's prose.

Confirmed empirically before deciding on the safety design: `claude -p
--permission-mode default` in headless (non-interactive) mode auto-denies
write/exec tool calls and reports them in a `permission_denials` array in
the final result — it does not hang waiting for a TTY approval that will
never come. This makes `default` permission mode a safe, non-blocking
"read/explore only" tier for headless spawns.

## Decision

Port the capability in-tree as `lib/tools/claude-delegate.ts`
(`claude_delegate` + `claude_delegate_status`), registered under the
existing `"Agent"` category / `"execute"` capability (same slot as
`delegate_to_agent` in `lib/tools/delegate.ts`), rather than keeping it
external or introducing a new category.

* **Safety-mode mapping**, wired through `resolveSafetyMode()`:
  * `safe` → refuse outright, no spawn.
  * `mostly_safe` (default) → force `--permission-mode default` unless the
    caller passes `allow_unsafe: true` for that call (same per-call
    escalation shape as `local_exec`'s `allow_unsafe`); Claude can read/
    explore freely, every write/exec attempt is auto-denied and surfaced
    via `permission_denials`.
  * `bypass` → honour the caller's requested `permission_mode` as-is.
  The forced tier uses `--permission-mode dontAsk`, not `default`: Claude
  Code's own docs document `dontAsk` for exactly this headless-auto-deny
  case ("auto-denies every tool call that would otherwise prompt you… the
  session never waits for input"); `default`'s headless behavior is not
  documented, even though it produced the same result empirically.
  `permission_denials` on the final `result` event is itself undocumented
  as of CLI 2.1.133 (no published stream-json schema exists — see
  anthropics/claude-code#24594) — treated as best-effort, not a stable
  contract, and confirmed present on every denied call tested.
* **Verify loop**: every call attaches a `changes` field — git status +
  diff-stat computed against the resolved workspace root via a shared
  `lib/tools/git-probe.ts` helper (also used by `workspace_status`) —
  instead of relying on Claude's own summary text.
* **Persistence moves into `lib/db`/`lib/stores`**: a new
  `claude_delegate_sessions` table (via the existing migration block in
  `lib/db/migrations.ts`) replaces the JSON sessions file; memory sync
  calls `listMemory`/`putMemory`/`deleteMemory` from `lib/stores/memory.ts`
  directly instead of over HTTP, since it's in-process now. The
  `claude-sync:*` namespace-prefix gate (only namespaces matching that
  prefix are eligible for the plain-markdown round trip) carries over
  unchanged.
* **`sync_memory` defaults to `"both"`** (the external version defaulted to
  `false`) — the point of bringing this in-tree is that Claude's
  session-local learning should flow into Jarela's own memory without the
  caller having to remember a flag.

### Consequences

* Good, because the calling agent gets a structured, checkable account of
  what Claude changed, not just prose it has to take on faith.
* Good, because `JARELA_TOOL_SAFETY=safe` now actually makes Claude
  delegation safe, consistent with every other execute-capability tool.
* Good, because there's one less loopback HTTP round-trip and one less
  hand-rolled JSON state file.
* Bad, because the `mostly_safe` default (auto-deny writes) means the
  common case — "let Claude make the change" — requires the caller to
  pass `allow_unsafe: true` explicitly. Accepted: matches this repo's
  existing bar for `local_exec`, and an agent that always needs write
  access can request `JARELA_TOOL_SAFETY=bypass` for that deployment.
* Bad, because spawning the real `claude` CLI in tests is slow, costs
  money, and isn't deterministic — unlike `local_exec`'s test convention
  of running real cheap commands. Accepted: an injectable spawn seam
  (`spawnImpl`) is used for unit tests instead, same shape the external
  version already had.

## More Information

Supersedes the external-tool version (`claude-subagent.cjs` /
`claude-memory-sync.cjs`, loaded from the external tools directory per
ADR-0013) — that copy should be retired once this ships. See
[ADR-0013](./0013-external-extension-contract.md) for the
external-tool contract this is moving off of, and
[ADR-0038](./0038-tool-capability-axis.md) for the category/capability
axes this tool registers under.
