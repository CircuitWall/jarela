# 0086 - Supervise Codex delegation through persistent sessions and live jobs

- Status: accepted
- Date: 2026-09-22

## Context

`codex_delegate` previously launched each `codex exec --json` invocation as
an isolated foreground subprocess. Unlike `claude_delegate`, it did not retain
a workspace session, offer a background status/cancel surface, or stream the
full delegated transcript into the chat tool card. That prevented the parent
agent and user from supervising Codex work as an ongoing developer task.

## Decision

Persist a provider-specific Codex session id per workspace/feature in SQLite,
reuse the existing in-process delegate job registry for background work, and
emit Codex progress through the existing tool-progress stream. The tool card
uses the shared delegate transcript contract, so Claude and Codex show the
same visible task, launch, and step information.

This preserves the existing single Next.js process: Codex remains a child
process managed by the tool call. It does not claim per-operation approvals.
Those require Codex App Server, whose JSON-RPC approval protocol is a later
increment; `codex exec` accepts only pre-set sandbox policy.

## Consequences

- Parent agents can resume Codex work, poll/cancel background tasks, and
  independently verify the resulting diff.
- Codex and Claude sessions cannot collide because their tables are separate.
- The user gains a visible live transcript without another frontend protocol.