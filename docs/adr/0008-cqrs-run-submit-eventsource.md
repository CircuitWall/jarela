# 8. Split run submit (command) from stream subscribe (query); use EventSource

Date: 2026-05-19

## Status

Accepted

## Context

Up to ADR-0007 the chat client had three transports for a single
"send a message and watch tokens stream back" interaction:

1. **WebSocket sidecar** — a `ws` server bound on a separate port
   (`JARELA_WS_PORT`, default 3219), discovered via `GET /api/v1/ws`.
   Behind Tailscale serve, it was exposed on a magic path
   `/__jarela_ws__` that the operator had to configure manually with
   `tailscale serve --bg --set-path=/__jarela_ws__ http://127.0.0.1:3219`.
2. **SSE-over-POST fallback** — `POST /api/v1/threads/<id>/run` returned
   a `text/event-stream` body consumed via
   `fetch().body.getReader()`.
3. **GET SSE reattach** — `GET /api/v1/threads/<id>/run` consumed the
   same way, used when the WS dropped mid-stream and the server-side
   run was still alive in `lib/agents/run-registry`.

All three converged on the same in-memory `run-registry` for the
publish side, so they were always functionally equivalent — the
duplication existed purely as transport-layer redundancy against
network flakiness. The code carried significant complexity to manage
the redundancy: a stall watchdog (`WS_STALL_TIMEOUT_MS`), an
app-level `{type:"keepalive"}` heartbeat, a `ws_drop_reattach` error
code that punched through `streamChatWS` into `useSSE` to trigger the
SSE leg, a session-storage cache of the WS URL keyed by origin, and a
`tailscale serve` path the operator had to know about.

This worked on desktop Chrome/Firefox. It did **not** work in iOS
Safari (verified on iOS 26.4.2, in both mobile Safari and installed
home-screen PWA, against a Tailscale-fronted host that desktop
clients reached fine on the same URL). Symptom: spinner forever, then
`TypeError: Failed to fetch`.

Root cause is iOS WebKit:

- `fetch(POST + JSON body).body.getReader()` for long-lived
  `text/event-stream` responses is unreliable on iOS — the response is
  buffered or aborted with `Failed to fetch` after a delay,
  particularly when the response is fronted by an HTTP/2 proxy
  (Tailscale serve uses HTTP/2).
- WebSocket from iOS Safari to a Tailscale-served path
  (`wss://<host>/__jarela_ws__`) is intermittently flaky compared to
  the desktop WebKit/Blink/Gecko implementations.

WebKit's reliable streaming primitive — battle-tested across iOS
versions and PWA contexts — is `EventSource` (Server-Sent Events on
a GET request). It is implemented natively, supports automatic
reconnection, works through HTTP/2 proxies, and survives the
browser's aggressive background-tab handling.

But `EventSource` is GET-only. To use it, the act of *submitting* a
message has to be separable from the act of *subscribing* to its
output.

## Decision

Adopt CQRS at the run transport layer:

1. **`POST /api/v1/threads/<id>/run`** — *command*. Body is the new
   user message (text + attachments + `stream_options`). The handler
   registers the run synchronously via `startRun()` and returns
   immediately with `202 Accepted`:
   ```json
   { "accepted": true, "thread_id": "...", "started_at": 1714e+12 }
   ```
   No response body streaming. The agent runs to completion in a
   detached async IIFE that broadcasts chunks into the registry, then
   persists the assistant message and emits the notification — same
   as today.

   If a run is already in flight for this thread (second tab,
   another device), POST returns `409 Conflict`:
   ```json
   { "accepted": false, "code": "run_in_flight", "thread_id": "..." }
   ```
   The client treats this as a signal to roll back its optimistic
   user bubble and re-queue the message for resubmission once the
   current run terminates.

2. **`GET /api/v1/threads/<id>/run`** — *query*. Unchanged in
   semantics: streams chunks via SSE. `stream_options` (the
   `show_tools` / `show_thinking` filter flags) are accepted as
   query string parameters. Always consumed client-side via
   `EventSource`, never via `fetch().body.getReader()`.

3. **`DELETE /api/v1/threads/<id>/run`** — unchanged.

Client lifecycle for one turn:

```
POST /threads/:id/run  ─→  202 (or 409, re-queue)
                            │
                            ▼
                       new EventSource(`/threads/:id/run?show_tools=…&show_thinking=…`)
                            │
                            ▼  text_delta, tool_call, tool_result, thinking_delta, done
                       es.close() on done/error
```

Because the POST resolves only after `startRun()` has registered the
active run, the subsequent EventSource open is guaranteed to find
the run in the registry — no race against the publish path.

The WS sidecar and `/api/v1/ws` discovery endpoint are removed.

### Removed pieces

- `lib/streaming/ws-server.ts` (the entire `ws` sidecar including
  ping/pong sweep, keepalive interval, attach-to-in-flight handler,
  cross-origin handshake guard).
- `app/api/v1/ws/route.ts` (the URL-discovery endpoint).
- The `streamChat` (POST-SSE) and `streamChatWS` async generators in
  `api/client.ts`, plus `getWsUrl` / `invalidateWsUrl` / the
  `jarela:ws-url:v2` sessionStorage cache.
- The `ws_drop_reattach` error-code plumbing in `useSSE`.
- The `JARELA_WS_PORT` env var.
- The `tailscale serve --bg --set-path=/__jarela_ws__` operator step
  in deployment docs.
- The `Container(stream, "Streaming Layer", "ws + undici", ...)`
  entry in the C4 diagrams.

### Kept

- `run-registry` (`startRun` / `broadcast` / `finishRun` / `subscribe`
  / `getRun` / `abortRun`) — the publish side is unchanged.
- The 4000-event ring buffer for late attachers — same code path
  EventSource clients use to catch up.
- Server-driven abort via `DELETE /run` → `AbortController` →
  LangGraph stream cancellation → terminal `error` + `done`.

## Consequences

### Reliability

iOS Safari (and PWA) now uses the only streaming primitive WebKit
supports reliably. The "Failed to fetch" failure mode is gone for
the entire iOS surface, not just the home-screen PWA. The simpler
desktop browsers gain the same benefit at no cost.

### Code surface

Three transports collapse to two endpoints (POST submit, GET
subscribe). One process (Next.js), one port. The streaming-layer
keepalive, stall watchdog, WS URL cache, and `ws_drop_reattach`
branch all go away. Net deletion of roughly 400 lines.

The single-Node-process invariant from CLAUDE.md is preserved
(actually strengthened — there was effectively a second port bound
by the sidecar; now there is only the Next.js port).

### Performance

One extra round-trip per turn (POST 202 before the GET opens). This
adds <50ms on loopback / <200ms over Tailscale. Imperceptible
against an LLM turn that takes seconds. Token deltas continue to
stream live — the user-visible "type-on" behaviour is unchanged.

### Operator-facing

The `tailscale serve` recipe is now the standard single-port
HTTPS-passthrough form, with no magic path:

```sh
tailscale serve --bg http://localhost:4312
```

(The backend scheme is `http://` because Jarela's Next.js server speaks
plain HTTP on loopback. `https+insecure://` is for self-signed HTTPS
backends and would yield a 502 from `tailscale serve` against an HTTP
server.)

`JARELA_WS_PORT` is no longer read. Setting it has no effect; the
variable is dropped from `.env.example` and the README ports table.

### Breaking change

The HTTP contract changes incompatibly:

- `POST /api/v1/threads/<id>/run` used to return a
  `text/event-stream` body. It now returns `202 application/json`.
- `GET /api/v1/threads/<id>/run` now accepts `?show_tools=` and
  `?show_thinking=` query params (additive).
- `GET /api/v1/ws` is removed (404).

Any external scripts or third-party clients that posted directly to
the run endpoint expecting a stream must:

1. Stop reading the POST response body for chunks; treat it as an
   acknowledgement only.
2. Open a follow-up `GET` to the same path (preferably as an
   `EventSource`) to receive the chunks.

This is recorded as a `BREAKING CHANGE:` footer on the implementing
commit.

## Alternatives considered

- **iOS-only UA branching.** Sniff `iPad|iPhone|iPod` in the client
  and route those clients through GET-only while keeping the old
  three-transport stack for desktop. Rejected: keeps the brittle
  code, adds another branch, and the same bug class affects iPadOS
  Safari pretending to be macOS via UA spoofing.

- **Tunnel the WebSocket through Next.js itself** (instead of a
  sidecar port). Investigated — Next.js 16 does not expose an HTTP
  upgrade hook to route handlers; we'd need a custom server, which
  conflicts with the standalone output and the per-user installer.

- **Long-poll `/run` with chunked transfer-encoding via `fetch()`.**
  Same iOS bug — `Failed to fetch` after the body has been held
  open past WebKit's buffer threshold.

- **Use `BroadcastChannel` between a service worker and the page** so
  the SW reads the streaming response and forwards chunks. Adds a
  SW-lifecycle dependency for a core code path; the SW would have to
  survive reloads and PWA cold starts and currently doesn't. Doesn't
  fix the underlying `fetch + getReader` bug, just shifts the
  fetcher.

`EventSource` solves the problem without any of these workarounds
and is the smallest possible delta from the current registry-based
publish architecture.
