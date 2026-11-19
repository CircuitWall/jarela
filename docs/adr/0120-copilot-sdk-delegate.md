# 0120 - Delegate to GitHub Copilot through the Copilot SDK

- Status: accepted
- Date: 2026-11-19

## Context

Jarela delegates coding work to locally installed CLIs: `claude_delegate`
(ADR-0071) and `codex_delegate` (ADR-0086), both of which spawn a child process
and parse its stdout, both defaulting to full parity with an interactive
session under `mostly_safe` (ADR-0087). GitHub Copilot already exists in Jarela
as an **LLM provider** (`lib/providers/github-copilot.ts`, device-flow sign-in),
but there was no way to hand a task to the Copilot agent runtime, which is a
different capability: it edits files and runs commands rather than answering a
prompt.

Three ways to drive that runtime were evaluated on 2026-11-19:

1. **CLI subprocess** — `copilot -p "<task>" --output-format json`, parsed the
   way the other two delegates parse their CLIs. Zero new dependencies, but the
   JSONL record shapes for prompt mode are not documented, so the parser would
   be guesswork, and permission decisions degrade to command-line flags.
2. **ACP server** — `copilot --acp --stdio` with `@agentclientprotocol/sdk`.
   Typed protocol with a permission callback, but public preview, and tool
   filters are fixed when the server starts rather than per session.
3. **Copilot SDK** — `@microsoft/copilot-sdk` (v2, formerly
   `@github/copilot-sdk`). Typed JSON-RPC to the same runtime with real
   permission callbacks, session resume and structured events.

## Decision

Implement `copilot_delegate` / `copilot_delegate_status` on the Copilot SDK.

**Transport.** The SDK can host the native runtime in-process over a C ABI
(FFI). That gives up crash isolation and pulls a platform binary into the Next
server process, so the delegate uses
`RuntimeConnection.forSpawnedStdio()`: the runtime lives in its own child
process and the SDK talks to it over stdio. The package and its per-platform
runtime packages are listed in `serverExternalPackages` and in the standalone
trace includes.

**Lifetime.** Starting the runtime costs a process spawn, so one runtime is
shared per process (keyed by runtime path, token and Copilot home) and each
delegate call owns one session. Session ids resume per workspace/feature, stored
in the shared memory store under `copilot-delegate-sessions` — a non-secret id,
so no schema migration was added for it. Sessions are disconnected after each
call; Copilot keeps the transcript on disk for the next resume.

**Permissions.** ADR-0087 parity applies: `safe` refuses the call outright, and
`mostly_safe`/`bypass` run the delegate as an interactive user would. Unlike the
CLI delegates, the SDK exposes each request before it runs, so the delegate
approves `approve-once` per request and records the count in the result instead
of granting blanket access up front. Refusals remain possible without changing
the tool surface if a future ADR decides to restrict a request kind.

**No clarifying questions.** The session is created without
`interaction.onUserInputRequest`, so the runtime's `ask_user` tool stays
disabled. An automated run has nobody to answer, and a parked turn would burn
its whole timeout instead of returning a usable answer.

**Cancellation.** A background job's cancel action calls `session.abort()` (the
SDK's in-session abort) through the delegate job registry's cancel hook, rather
than signalling a child process.

**Authentication.** The delegate reuses the **GitHub integration credential**
(`github.token`), so it does not introduce a second GitHub secret; that token
needs the `Copilot Requests` permission when it is a fine-grained PAT. When no
GitHub credential is saved, the runtime falls back to the Copilot CLI's stored
sign-in (`copilot login`), then `COPILOT_GITHUB_TOKEN`. Classic `ghp_` tokens are
not supported by Copilot, and Jarela's own device-flow OAuth token belongs to the
VS Code Copilot client id, so it is deliberately not reused here.

## Consequences

- Good: the delegate gets typed events, per-request approvals, session resume
  and abort-based cancellation instead of stdout scraping and process signals.
- Good: the spawned transport keeps a runtime crash out of the Next server.
- Bad: a new dependency with platform-specific runtime packages
  (`@microsoft/copilot-sdk-<platform>`), adding install size and a CI
  requirement that optional platform packages resolve on every runner.
- Bad: the runtime is pinned to the SDK's bundled version; replacing it means
  setting a runtime path and taking on that compatibility.
- Bad: there is no health probe for this integration yet — a bad token
  surfaces on the first delegate call rather than in Settings.
- Neutral: the chat UI's live job panel is wired for the Claude/Codex job
  routes only. Copilot jobs still return a job id, poll through
  `copilot_delegate_status`, and deliver owned results through
  `tool_result_get`; the panel wiring is a follow-up.

## More Information

Researched against `@microsoft/copilot-sdk@2.0.1` (runtime 1.0.114) on
2026-11-19:

- <https://github.com/github/copilot-sdk> (Node.js README, API reference)
- <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference>
- <https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server>
