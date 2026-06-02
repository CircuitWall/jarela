---
status: accepted
date: 2026-06-02
deciders: example-user, claude
---

# Tool-emitted recovery hints + slimmer system-prompt playbook

## Context and Problem Statement

ADR-0049/0050/0051 built a stable error-code vocabulary across tools, providers, and the REST surface. ADR-0049 also added a **system-prompt playbook** — a ~25-line block listing every error code and telling the agent how to react.

Two problems with the playbook:

1. **The system prompt is the wrong place for tool-specific recovery.** The generic rule "for `invalid_args`, re-read the tool description and retry once" doesn't help when the *specific* recovery path is "call `jira_list_projects` first to discover valid keys." The tool itself knows what to do; the system prompt is too far from that knowledge to encode it for every code × every tool.

2. **The playbook is ~300 tokens of overhead on every turn.** Cheap on Opus, expensive on a 32k-context Copilot model. Most of the prose is restating things models already understand from the JSON shape (a 401 means auth failed; a 404 means not-found).

User pushback during the bloat audit:
> "About tool error, I guess the error honest passthrough to agent is good thing, however, the tool itself, for example wrong parameter etc should give agent right way to correct it."

The right architecture: the **tool** contributes the domain-specific recovery hint; the **system prompt** keeps only the generic rules (don't retry timeouts blindly, never claim a tool succeeded after seeing an error_code, etc).

## Decision Drivers

* **Co-locate recovery guidance with the failure source.** The tool that returned `invalid_args` knows what valid args look like.
* **One source of truth per code × tool.** A new tool added later doesn't require updates to a centralised playbook — it just emits its own hint.
* **Keep the wire shape additive.** The hint is `optional`; existing consumers (chat UI, extractToolError, agent) keep working unchanged.
* **Cut the per-turn token cost.** Compress the playbook to the truly-generic 6-line block.

## Considered Options

* **(A) Status quo — comprehensive playbook, no per-tool hints.** Easy to maintain centrally; can't encode tool-specific knowledge.
* **(B) Pure per-tool hints, no playbook.** Each tool encodes its own recovery; system prompt stays silent on errors. Risk: the truly-generic rules (no double-retry, never lie about success) get lost.
* **(C) Both — hint on the tool, slim playbook in the system prompt.** Tool wins on specifics; playbook covers cross-cutting rules.

## Decision Outcome

Chosen: **(C) Both, with the playbook trimmed to ~7 lines**.

The error envelope (`HttpToolError`, the legacy `{error, code}` shape, the PR-4 `{kind:"error", code, message}` shape) gains an optional `hint?: string` field. `extractToolError` reads it and forwards onto the `tool_result` chunk's `error_hint` field (alongside `error_code` / `error_message` from PR-A).

`buildToolErrorPlaybook` shrinks from ~25 lines to 7. The kept rules are the ones that aren't expressible at the tool level:
- Prefer the tool's own `error_hint` over generic guidance
- Never claim success after `error_code`
- Don't retry the same call+args twice in a row
- Auto-retry only the named transient codes (network/5xx/429/timeout-with-hint), once
- Permanent codes (auth, denylist, perm, etc.) — surface to user, don't retry
- Schema codes (invalid_args, unknown_tool, mcp_unavailable) — read the tool's hint or its description

Each tool layer adds hints where it has domain context:

- **Atlassian / GitHub / Jira-Align / Google / Microsoft fetches**: `defaultHttpHint(provider, code)` produces a baseline hint for 401/403/404/429 ("Check Settings → Integrations → [provider]…"). GitHub overrides 429 with the rate-limit specifics; Gmail/Outlook override 401 with the OAuth reconnect flow (because there's no API key — the user has to re-grant).
- **fetch.ts**: `ssrf_blocked` ("don't bypass — tell the user"), `redirect_limit` ("try the canonical URL"), `tool_timeout` ("the page is slow, narrow it or use a different URL").
- **exec.ts**: `command_not_found` (names the binary the agent expected), `permission_denied` ("the user needs chmod / different user"), `tool_timeout` ("don't retry the same command").
- **files.ts**: `file_not_found` ("verify with `file_stat` first — case + spelling matter, ~/foo expands to HOME"), `denylist` ("safety refusal — don't bypass; opt in via JARELA_ALLOW_SENSITIVE_FILES"), `path_is_directory` / `path_not_directory` ("you got the wrong shape; use file_list / file_stat").

### Consequences

* Good — agent sees specific, actionable guidance per failure. "missing project_key" + "call jira_list_projects" beats "re-read the tool description."
* Good — system prompt drops ~250 tokens per turn. Negligible on Opus, meaningful on small-context models.
* Good — adding a new tool: emit your own hint where useful. No playbook update needed.
* Good — UI consumes `error_hint` for free via the existing chat error rendering.
* Good — the test suite gained 11 new cases (hint pass-through on both envelope shapes; `defaultHttpHint` per status code).
* Bad — hint copy is now spread across ~6 files. Mitigated: `defaultHttpHint` centralises the common case (401/403/404/429); only tool-specific overrides live in the tools.
* Bad — hints are static strings, not parameterised. A future improvement could template them ("Open Settings → Integrations → ${integration_name} ↳ Atlassian site URL"); not worth it today.

## Pros and Cons of the Options

### (C) Both — slim playbook + per-tool hints (chosen)

* Good — best of both: cross-cutting rules stay central, specifics stay local.
* Good — tool authors don't have to keep a separate playbook in sync.
* Neutral — hint string lives in 6+ files. Manageable; centralised for the common HTTP cases.

### (B) Pure per-tool hints

* Good — most prompt-token efficient.
* Bad — risks losing the generic rules. A new tool author who forgets to mention "don't retry permission_denied" leaves the agent free to loop.

### (A) Comprehensive playbook only

* Good — single source.
* Bad — the per-tool specifics that motivate this ADR can't be expressed there. The audit's "agent just retries the same failing call with the same args" failure mode reproduces.

## Implementation notes

* **Schema**: `ToolResultPayloadSchema` gains `error_hint?: z.string()` (alongside the existing `error_code`/`error_message`). The flat wire shape inherits via the existing `.extend(...).shape` pattern. No client migration needed; `error_hint` is optional.
* **`extractToolError`**: reads `hint` off either the `kind:"error"` envelope or the legacy `{error, code, hint}` envelope. Empty-string and non-string hints are treated as absent so a misbehaving tool can't smear an empty `hint=""` field onto the chunk.
* **`HttpToolError`**: the interface in `lib/tools/error-codes.ts` gains optional `hint?: string`.
* **`defaultHttpHint(provider, code)`**: shared baseline hint for HTTP wrappers. Returns a string for 401/403/404/429; returns undefined for `http_5xx` / `http_4xx` / `tool_timeout` etc. — those codes already have the playbook's generic guidance, no hint needed.
* **Playbook**: `buildToolErrorPlaybook` shrinks from ~25 lines to 7 generic rules. The per-code recipes move into the tools.
* **Tests**: 11 new cases — hint pass-through on both envelope shapes (kind:"error" + legacy), absent/empty/non-string hints treated as absent, `defaultHttpHint` per code.

## Cross-references

ADR-0049 (the original playbook + error_code field — this ADR refines it). ADR-0050 (HTTP error vocabulary the hints reference). ADR-0054 (chat error card — already renders `error_message`; will pick up `error_hint` rendering in a follow-up).
