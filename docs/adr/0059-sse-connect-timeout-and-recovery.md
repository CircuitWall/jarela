---
status: accepted
date: 2026-06-02
deciders: andwu, claude
---

# Soften SSE connect-timeout + recover stream drops via Reconnect

## Context and Problem Statement

A user-visible failure mode was: send a message → red "Client request failed — EventSource connect timeout" toast appears → no live stream → no obvious recovery path. Re-opening the chat showed the assistant *had* replied. The agent ran successfully on the server; the client gave up too early and treated it as failure.

Two design issues fed into this:

1. **8s connect timer was too aggressive.** [api/client.ts:873](../../api/client.ts#L873) closed the EventSource if `onopen` hadn't fired within 8000ms. `onopen` fires when SSE response *headers* flush, not when the first event arrives. Our `/threads/{id}/run` GET does work before the flush — auth, agent boot, LangGraph + sqlite + MCP server load on cold paths, possibly a checkpoint write — and on corp proxies / first-request-after-idle, that flush legitimately landed past 8s.

2. **No recovery path.** When the timer fired, useSSE caught the error and surfaced a generic `client_error` toast. The submit POST had already been accepted; the run was still in flight on the server (or had completed and written its result to the thread). But the UI treated the connection failure as if the run itself had failed: no message refetch, no Reconnect button, no indication the agent might have finished anyway. From the user's perspective the turn was "lost" until they navigated away and back.

## Decision Drivers

* **Distinguish "couldn't submit" from "submitted, then stream broke".** They have different recovery semantics — retry vs reconnect.
* **Preserve EventSource native auto-reconnect.** Closing the source on a transient drop defeats the protocol's built-in recovery.
* **Make the recovery path obvious.** Refetch messages so any committed result lands; expose Reconnect so the live stream can resume via the server's replay buffer.
* **Tone-match severity.** A stream drop that auto-refetched is not the same UX as "your turn failed entirely" — surfacing both as red `client_error` was alarming and misleading.

## Considered Options

* **(A) Auto-attach silently on every stream drop.** Cleanest for the user (no error to dismiss), but hides the fact that something went wrong — and if the auto-attach also fails (404 because run TTL-evicted, network is genuinely down), we now have a second silent failure cascading into a frozen UI.
* **(B) Bump the timer + leave error handling as-is.** Cheap fix; doesn't address the no-recovery-path problem.
* **(C) Bump the timer AND distinguish stream-drop from client-error AND surface Reconnect.** Costs ~80 LOC across three files; fixes both issues with a clear, user-visible recovery path.

## Decision Outcome

Chosen: **(C)**.

### 1. Connect-timer raised 8s → 30s

[api/client.ts:868-890](../../api/client.ts#L868-L890). Generous enough that a cold-boot of LangGraph + sqlite + MCP loaders behind a corp proxy can flush headers before the kill timer fires. If `onopen` genuinely never fires within 30s, the server is wedged and a hard fail is correct — we still need *some* upper bound to avoid a permanently-stuck UI gate.

The kill semantics are otherwise unchanged: at 30s, `streamError = "EventSource connect timeout"` and the iterator throws, the catch in `useSSE.start()` runs.

### 2. `submitted` flag distinguishes failure modes

[hooks/useSSE.ts](../../hooks/useSSE.ts) `start()` now tracks whether `submitRun()` succeeded before the throw. The catch branch:

* If `submitted === false`: the POST itself failed. Surface as `client_error` (red, retryable). Same behavior as before.
* If `submitted === true`: the run was accepted server-side; the failure is a stream drop. Call `onDone?.()` to refetch messages (any committed assistant reply lands in chat) and surface as `stream_dropped` (amber, *reconnectable*).

### 3. New `stream_dropped` recipe + Reconnect affordance

[components/chat/ErrorCard.tsx](../../components/chat/ErrorCard.tsx) gains:

* A `tone: "warning"` switch on the recipe → renders amber instead of red. Stream drops are warnings, not errors.
* A `reconnectable` flag + `onReconnect` prop. When both present, the card renders a **Reconnect** button.
* The `stream_dropped` recipe: title "Stream connection dropped", hint "Refetched the latest messages — the agent may still be running. Reconnect to resume the live view."

[components/chat/ChatView.tsx:558](../../components/chat/ChatView.tsx#L558) wires `onReconnect={() => attach(threadId)}`. `attach()` opens a fresh SSE GET; if the run is still in flight, the server's replay buffer fills in the gap. If the run has already finished and TTL-evicted, the EventSource closes cleanly and the activity badge clears — no second error toast.

### Consequences

* Good — false-positive timeouts on cold boot largely eliminated (8s → 30s envelope).
* Good — stream drops no longer present as "your turn failed". User sees their messages refresh + a soft notice with a one-click recovery action.
* Good — clear separation: red = something the user should act on (settings, retype); amber = transient issue with a recovery path already in motion.
* Good — Reconnect uses existing `attach()` machinery; no new transport code.
* Bad — 30s wall-clock is a long wait if the server *is* genuinely down. Mitigated by the activity strip ("Sending…") still being visible; user can hit Stop.
* Bad — `submitted` flag adds one more piece of state to track in `start()`. Acceptable: it's a single boolean, scoped to the call.
* Neutral — auto-attach (option A) was rejected for now. Easy to revisit if the manual Reconnect button proves redundant in practice.

## Pros and Cons of the Options

### (C) Bump + distinguish + Reconnect (chosen)

* Good — addresses both the harshness and the missing recovery path.
* Good — tone-matches severity.
* Bad — touches three files; one ADR.

### (B) Just bump the timer

* Good — minimal change.
* Bad — doesn't fix the "scary toast hides a successful run" UX.

### (A) Auto-attach silently

* Good — best UX when it works.
* Bad — silent cascading failure when it doesn't; hard to debug from a user report.
* Bad — opaque to the user; they don't know the agent might have finished.

## Implementation notes

* The 30s value is hard-coded. If we later see legitimate cold-boot windows past 30s (e.g. very slow MCP servers booting in parallel), promote to a JARELA-prefixed env var. Not done now to avoid premature configurability.
* The `tone` field defaults to "error" so all existing recipes render unchanged — no visual regression for the other ~12 codes.
* `attach()` resets `error` to null on entry, so a successful Reconnect clears the warning card automatically. If Reconnect *fails*, the same surfacing logic in `attach()`'s catch (currently just `onDone?.()`) re-runs; we don't push a fresh error there because the messages-refetch is the intended outcome — same philosophy as start()'s submitted-but-dropped path.

## Cross-references

ADR-0008 (single-transport SSE — POST submit + GET subscribe). ADR-0049/0050/0051/0054 (error vocabulary the recipes layer over). [api/client.ts:790-910](../../api/client.ts#L790-L910) `subscribeRun`. [hooks/useSSE.ts](../../hooks/useSSE.ts) `start()`/`attach()`.
