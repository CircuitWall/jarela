---
status: accepted
date: 2026-06-02
deciders: example-user, claude
---

# Standard error-code vocabulary across HTTP and filesystem tools

## Context and Problem Statement

ADR-0049 promoted `error_code` + `error_message` to first-class fields on the `tool_result` chunk so the LLM and the chat UI can branch on a stable identifier instead of grepping prose. That ADR also added a system-prompt playbook that names ~12 codes (`http_401`, `tool_timeout`, `invalid_args`, `denylist`, etc.) and tells the agent how to react to each.

What didn't exist yet: any of those codes were actually *emitted* by the tools. Every HTTP-touching tool had its own ad-hoc error shape:

- `lib/tools/atlassian.ts:90` returned `{error: "Atlassian 401: ...", url}` — the status was buried in the message text.
- `lib/tools/github.ts:67` returned `{error: "GitHub ${status}: ..."}`. GitHub's *primary* rate-limit returns 403 + `X-RateLimit-Remaining: 0`, not 429 — the agent had no way to distinguish that from a permissions failure.
- `lib/tools/jira-align.ts:109` mirrored Atlassian's shape.
- `lib/integrations/{gmail,microsoft}-oauth.ts` (the shared fetch helpers feeding gmail.ts / outlook.ts / calendar.ts) did the same prose-only thing.
- `lib/tools/fetch.ts` returned strings like `"Refused to fetch private/loopback address (...)"` for SSRF refusals and `"too many redirects"` for redirect caps — both indistinguishable to a code-branching consumer.
- `lib/tools/exec.ts` swallowed spawn errors as a generic exit-code 1; ENOENT (command not found) and EACCES (permission denied) and SIGTERM (timeout) all looked the same.
- `lib/tools/files.ts` threw `Error` from policy violations and from `fs` syscalls; both became opaque `tool_threw` after dispatch caught them.

So the playbook had nothing to branch on. The agent kept retrying rate-limited calls, kept retrying SSRF-blocked URLs, kept treating "command not found" as "I should try a different command line" instead of "I should tell the user to install the binary."

## Decision Drivers

* **The vocabulary in ADR-0049 is the contract; tools must speak it.** No point promoting a `code` field if every tool emits ad-hoc strings.
* **Don't break existing payload consumers.** The `error` text + `url` fields stay; codes are purely additive.
* **One mapping function per failure class.** HTTP tools shouldn't each duplicate "401 → http_401" logic — bugs creep in (GitHub's 403-as-rate-limit was the canonical example).
* **Filesystem failures need a classifier too.** Node's fs surfaces a stable `err.code` (`ENOENT`, `EACCES`, etc.); we just have to map it once and use it everywhere.
* **`Retry-After` should ride along.** When a 429 comes back with the header, the agent's playbook has a "wait that long, retry once" branch. Parsing it once at the helper saves every tool from doing it.

## Considered Options

* **(A) Centralise the vocabulary in `lib/tools/error-codes.ts`; every tool calls helpers there.** One source of truth.
* **(B) Each tool keeps its own classifier, with a shared README.** Drifts immediately — observed behaviour from the GitHub primary-rate-limit case.
* **(C) Wrap every tool's output in a normalising decorator at registration.** Pushes the classification out of the tools and into the dispatch layer. Hides the codes from the tool author who has the most context to label correctly (e.g., GitHub's 403-with-rate-limit-remaining-zero requires reading both status and a header — only the github.ts wrapper has that data).

## Decision Outcome

Chosen: **(A) Centralised helpers in `lib/tools/error-codes.ts`**.

The new module exports four primitives:
- `httpStatusToErrorCode(status)` → maps HTTP status to the playbook codes (`http_401`, `http_403`, `http_404`, `http_429`, `http_4xx`, `http_5xx`, `http_error`).
- `networkErrorCode(err)` → recognises `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ENOTFOUND`, `AbortError`, etc., returns `network_error` / `aborted` / null.
- `classifyFsError(err)` → maps Node fs codes (ENOENT/EACCES/EPERM/EISDIR/ENOTDIR/EEXIST) to `file_not_found` / `permission_denied` / etc., and preserves caller-attached codes (e.g., `denylist`).
- `parseRetryAfterMs(headerValue)` → parses both integer-seconds and HTTP-date forms.

Every HTTP-touching tool wrapper imports them and emits the standardised envelope. Every filesystem tool wraps its catches with `classifyFsError`. Tools that legitimately need a custom code (e.g., `fetch.ts`'s `ssrf_blocked`, `redirect_limit`) attach it at the throw site; classifiers don't override caller intent.

### Consequences

* Good — every tool failure now lands in the agent's playbook with a code that branches correctly.
* Good — GitHub's primary-rate-limit (`403` + `X-RateLimit-Remaining: 0`) is correctly remapped to `http_429` so the agent retries with backoff instead of giving up.
* Good — `Retry-After` is parsed once and forwarded as `retry_after_ms` on every 429 response — the playbook has a deterministic value to wait on.
* Good — adding a new HTTP-touching tool is one import + one envelope build; no re-deriving the mapping.
* Good — backward compatible: existing `{error, url}` shape gains `code` + `status`; nothing is removed.
* Bad — `Date.now()` is back in the `parseRetryAfterMs` HTTP-date branch. Acceptable: `Retry-After` is an external server's header, the runtime read is harmless, and tests assert non-negativity rather than exact values.
* Bad — files.ts's `throwWithCode` helper attaches `code` to a plain `Error`. Mildly ugly compared to a custom class, but the catch sites read `err.code` either way, and a custom class would force every catcher to import it.

## Pros and Cons of the Options

### (A) Centralised helpers (chosen)

* Good — one source of truth; tools can't drift.
* Good — small per-file change at the wrapper level (atlassian's `_atlassianFetch`, github's `ghFetch`, etc.) cascades to every tool that uses the wrapper.
* Good — testable in isolation; the helpers have no side effects.
* Neutral — adds a `lib/tools/error-codes.ts` module. Small, focused.

### (B) Per-tool classifiers

* Good — each tool can encode unique logic.
* Bad — duplication makes the GitHub primary-rate-limit class of bug inevitable.
* Bad — the playbook in the system prompt assumes a stable vocabulary; without enforcement it drifts.

### (C) Decorator at the dispatch layer

* Good — tools stay simple.
* Bad — the dispatch layer doesn't have the per-API context (e.g., GitHub headers) needed to classify correctly.
* Bad — moves classification away from where the failure happened; harder to debug.

## Implementation notes

### HTTP wrappers (atlassian / github / jira-align / google / microsoft)

Each `_xxxFetch` wrapper now returns:
```ts
{
  error: "<provider> <status>: <body>",  // unchanged
  code: httpStatusToErrorCode(res.status),
  status: res.status,
  url,
  retry_after_ms?: number,  // present on 429s when Retry-After / x-ratelimit-reset is set
}
```

GitHub's `ghFetch` adds a wrapper `githubStatusCode(res)` that re-classifies `403 + X-RateLimit-Remaining=0` to `http_429`, and a `githubRetryAfterMs(res)` that prefers `x-ratelimit-reset` (epoch seconds) over `Retry-After` since that's GitHub's stable signal.

### `lib/tools/fetch.ts`

URL-format failures → `invalid_args`. SSRF refusals → `ssrf_blocked`. Redirect cap exceeded → `redirect_limit`. Invalid redirect target → `invalid_redirect`. Catch block distinguishes `AbortError` (`tool_timeout`) from `ECONN*` / `fetch failed` (`network_error`) via `networkErrorCode`.

### `lib/tools/exec.ts`

`execErrorCode` reads `err.code`:
- `ENOENT` → `command_not_found`
- `EACCES` → `permission_denied`
- `ETIMEDOUT` / SIGTERM-text-in-stderr → `tool_timeout`
- spawn-failed-no-status → `command_failed`
- non-zero exit (the normal "command ran and returned 1" path) → `command_nonzero_exit`

The denylist refusal uses `code: "denylist"`. Empty command → `invalid_args`.

### `lib/tools/files.ts`

`throwWithCode(message, code)` helper wraps `Error` with a code. Used at every policy-violation throw site (denylist, JARELA_DB_DIR write refusals, sensitive-file refusals, missing-path errors). Every catch site appends `code: classifyFsError(err)` to its JSON envelope; `classifyFsError` reads caller-attached codes first, then Node fs codes.

### MCP

No change in this PR. The `getMcpTools()` allowlist already excludes broken servers; calling such a tool produces `unknown_tool` (already in the playbook). Per-server reconnect lands in PR-G.

## Cross-references

ADR-0049 (first-class error_code on tool_result chunks — the consumer of this vocabulary), ADR-0047 (central tool dispatch — the chokepoint that already normalises error throws), ADR-0048 (registered-tool wrap — every tool call lands in dispatch).
