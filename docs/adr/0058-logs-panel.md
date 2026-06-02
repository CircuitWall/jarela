---
status: accepted
date: 2026-06-02
deciders: andwu, claude
---

# Live server-log panel via console patch + SSE

## Context and Problem Statement

86 `console.{log,info,warn,error}` calls live in `lib/`. They surface real failure information — provider error bodies, idle-watchdog fires, retry warnings, MCP server load failures, validator hits — but the only way to see them today is to attach to the terminal where the server runs.

Operators running Jarela through launchd / systemd / a Windows service can't easily tail those logs without going to the install dir, finding the right log file, and `tail -f`-ing. The audit + the user's request: surface these in-app, in real time, with filters and search.

A plain "stream stdout" approach would work but loses level metadata; a structured logger migration would touch 86 sites and isn't justified. The middle path: **patch `console` once at boot to also push to an in-memory ring buffer + broadcast to SSE subscribers**. Original stdout/stderr writes are preserved verbatim — operators tailing the terminal see exactly the same output as before.

## Decision Drivers

* **Zero migration cost.** No `import { logger }` rewrite across 86 sites.
* **Preserve stdout/stderr fidelity.** Anyone tailing the terminal must see the exact same output. The patch is additive.
* **Bounded memory.** A ring of 2000 entries (~150 KB at typical line size) handles a session's worth of logs without risk.
* **Live, not polled.** Operators want to *see* the failure as it happens.
* **Loopback-only.** The endpoint is gated by the same auth as the rest of the API; redact obvious secrets in the line text before storing or broadcasting.

## Considered Options

* **(A) Migrate to a structured logger.** Largest payoff long-term; biggest effort. Out of scope for this PR.
* **(B) Pipe stderr to a tail endpoint.** Simple. Loses level metadata; doesn't capture `console.log`/`info` (which write to stdout, not stderr).
* **(C) Patch `console.{log,info,warn,error}` at boot to dual-write.** Captures every call exactly where it's made; preserves levels; preserves stdout/stderr; idempotent via a global Symbol guard.

## Decision Outcome

Chosen: **(C) console patch + SSE feed**.

`lib/logging/sink.ts`:
- 2000-entry ring buffer (`LogEntry { seq, ts, level, text }`).
- `installConsolePatch()` — idempotent (Symbol guard) wrapper around the four console methods. Original methods are invoked first (stdout/stderr unchanged), then the line is redacted and pushed to the ring + broadcast to subscribers.
- `subscribe(fn)` returns an unsub. Subscribers receive *new* entries only — replay backlog via `recentEntries(N)`.
- Redaction pass: replaces `Authorization: Bearer …`, `api[_-]?key=…`, `sk-…`/`ghp_…`/`gho_…` token shapes with `[redacted]`. Best-effort — terminal output is unchanged for full-fidelity debugging on a trusted host.

`app/api/v1/logs/route.ts`:
- `GET /api/v1/logs` — SSE stream, replays the ring then forwards live.
- `GET /api/v1/logs?since=<seq>` — replays only entries newer than the seq (used by the panel on reconnect; no duplicates).
- `GET /api/v1/logs?recent=<N>` — JSON snapshot of the last N entries (no streaming; for export).
- 25s heartbeat (`: heartbeat\n\n`) so corp proxies don't kill idle connections.

`components/logs/LogsPanel.tsx`:
- Subscribes via EventSource. Reconnects pass `?since=<lastSeq>` so the user doesn't lose any entries across drops.
- Filter UI: per-level toggle chips (log/info/warn/error), free-text grep box.
- Autoscroll toggle (off lets the user read backlog without being yanked down by new entries).
- Pause/Resume button (closes the EventSource entirely, not just hides updates).
- Copy-filtered-to-clipboard.
- Local clear (UI only — server ring keeps the entries; useful when you want to start observing from "now").
- Mounts as an Advanced-tier tab in the existing AppShell tab system.

`instrumentation-node.ts`:
- Calls `installConsolePatch()` first thing in `bootNode()`. Production path.
- The SSE route's `ensurePatched()` covers dev-mode (where `bootNode` is intentionally skipped) — installs on first request.

### Consequences

* Good — operators can debug the running server without leaving the app.
* Good — every existing `console.*` call is captured automatically; no migration.
* Good — terminal output is unchanged.
* Good — SSE auto-reconnect + `?since=<seq>` means no missed entries across transient drops.
* Good — bounded memory by construction (ring + redaction).
* Bad — `console.*` is monkey-patched globally. Dev HMR risk mitigated by `Symbol.for("@jarela/console-patched")` guard; the patch is idempotent.
* Bad — redaction is regex-based; new credential formats won't be redacted until the pattern list is extended. Acceptable: terminal output is the source of truth for full-fidelity debugging; the panel is a convenience.
* Bad — subscriber broadcast is synchronous; a slow subscriber (e.g. a hung SSE response) could marginally slow log emission. Mitigated by `try/catch` per subscriber + the controller's clientGone check; the worst case is a few-microsecond delay per logged line.

## Pros and Cons of the Options

### (C) Console patch + SSE (chosen)

* Good — one-line install, captures everything.
* Good — idempotent install survives HMR and reload.
* Good — additive: stdout/stderr fidelity preserved.
* Neutral — patches a global. Risk bounded by the Symbol guard + try/catch.

### (B) Pipe stderr

* Good — no monkey-patch.
* Bad — stdout calls (the bulk) bypass it.
* Bad — no level metadata.

### (A) Structured logger migration

* Good — long-term right answer.
* Bad — out of scope; 86 sites to rewrite + risk of behavioral drift in any of them.

## Implementation notes

* `LogEntry.seq` is monotonic per process. Resets on restart. Used by the panel to dedupe across EventSource reconnects.
* The redaction list is in `REDACTION_PATTERNS` (sink.ts). Adding a new pattern is one line.
* Subscriber errors are swallowed (`try/catch` per fan-out) so a buggy subscriber can't crash the console patch.
* Heartbeat interval (25s) is below typical proxy idle timeouts (~30–60s) but high enough that the SSE stream isn't noisy.
* Test surface: 14 unit tests cover capture, redaction, ring/seq/subscriber semantics, idempotent install. The console patch is shared global state, so tests use `_resetLogSink()` between cases to clear the ring.

## Cross-references

ADR-0009 (proxy story — same `X-Accel-Buffering: no` header pattern). The chat run-stream SSE in `app/api/v1/threads/[thread_id]/run/route.ts` (same heartbeat / cancel cleanup pattern). The dispatch log in `lib/tools/dispatch.ts` and the validator log in `lib/agents/output-validator/telemetry.ts` (both write to console; both now visible in the panel via the patch).
