---
status: accepted
date: 2026-06-02
deciders: andwu, claude
---

# Output validator hit-rate telemetry + escape-hatch flag

## Context and Problem Statement

The output validator (ADR-0037) is a 555-LOC subsystem that detects four shapes of fabrication:

- `claim_without_tool` — assistant text claims work was done but no tool fired this turn
- `citation_unregistered_tool` — text contains `(via foo)` for a tool not in the registry
- `citation_uncalled_tool` — text contains `(via foo)` for a tool not invoked this turn
- `summary_without_action` — `## Summary of changes` with no tool calls

The bloat audit flagged it as a Tier-2 candidate ("instrument hit rate, decide on simplification or removal"). The user agreed in principle but pushed back on immediate removal — asked for verification that the chat UI renders gracefully without it AND that the failure modes the validator catches aren't simply hidden under good UI.

Per the bloat audit's revised recommendation:

> If hit rate <0.5% of turns → delete (rare enough that improving the prompt is cheaper than 555 LOC of detection).
> If hit rate 0.5–5% → simplify (keep claim detection, drop citation-mismatch heuristic which is the noisiest).
> If hit rate >5% → keep as-is and consider if model choice is the real problem.

To make that decision, we need data. This ADR ships the instrumentation.

## Decision Drivers

* **Don't change validator behaviour.** The audit's whole point is "should we keep this?" — that decision needs the validator running normally so the rate is the production rate.
* **Bounded memory.** Telemetry can't grow indefinitely. A ring buffer is enough for "rate over the last N runs" reasoning.
* **Process-local is fine.** The decision criterion is a hit rate over a few weeks of normal use, not historical data. No DB writes needed.
* **A/B-able.** Operators must be able to disable the validator without redeploying — both for emergencies (false-positive storm flagging legit replies) and for the eventual "what happens if we delete this" comparison.
* **Queryable from outside.** A dashboard endpoint lets the user read the stats without scraping logs.

## Considered Options

* **(A) console.log everything; rely on log scraping.** Simplest. Hard to query.
* **(B) DB table per-fire row.** Most flexible. Ships to ADR-0044's stream-chunk-style schema. Overkill for the question we're answering.
* **(C) In-memory ring buffer + structured log line + read endpoint.** Bounded, queryable, no schema migration.

## Decision Outcome

Chosen: **(C) In-memory ring + console-friendly log + dashboard endpoint**.

`lib/agents/output-validator/telemetry.ts`:
- Ring buffer (`RING_CAPACITY = 500`) of `ValidatorTelemetryEntry` records: `{stage, kind, evidence?, tools_called, ts}`.
- `validateWithTelemetry(stage, text, toolCalls, allowedTools)` — drop-in replacement for `validateAssistantOutput` that records the outcome before returning.
- `getValidatorStats()` returns `{total, ok, by_kind, by_stage, hit_rate, disabled}`.
- `recentValidatorEntries(limit?)` returns the most recent N entries.
- `_resetValidatorTelemetry()` for tests.
- `JARELA_DISABLE_OUTPUT_VALIDATOR=1` short-circuits the validator to `{ok: true}` without invoking the underlying detectors. Calls are still recorded (so disabled-period and enabled-period rates can be compared in the same buffer).

`run-thread.ts` swaps both `validateAssistantOutput(...)` callsites to `validateWithTelemetry("stall_retry_check"|"footer_check", ...)`. No behaviour change to the validation logic itself.

`/api/v1/dashboard/validator` GET endpoint:
- Default: returns the stats object.
- `?recent=N`: also returns the last N ring entries (capped at 500).

### Consequences

* Good — every validator call is now observable via console (grep `[validator] kind=…`) AND queryable (`curl /api/v1/dashboard/validator`).
* Good — operator can disable the validator with one env var, observe whether anything regresses, and re-enable instantly.
* Good — when we have enough data to decide on removal, the decision is data-driven rather than aesthetic.
* Good — process-local design avoids the DB migration the bigger telemetry ambitions would require.
* Bad — stats reset on server restart. Acceptable: the decision is "rate over the last few weeks of typical use," not historical analysis.
* Bad — the `disabled: true` flag in stats only reflects the env at read time, not historical entries. If you flip the flag mid-buffer the stats from before look indistinguishable from "validator was on and didn't fire." Mitigated: the buffer is small (500), turnover is fast, and operators flipping the flag should snapshot stats first.

## Pros and Cons of the Options

### (C) In-memory ring + endpoint (chosen)

* Good — small, focused, no migrations.
* Good — endpoint exposes the same data the user would compute by hand.
* Good — escape-hatch flag does double duty (emergency disable + A/B test).
* Neutral — process-local; resets on restart. Fits the decision question.

### (B) DB table

* Good — historical analysis possible.
* Bad — the question is "kill or keep over the next few weeks." Historical data isn't load-bearing.
* Bad — schema migration + dashboard query + index design. ~ADR-worthy alone, for one telemetry stream.

### (A) Logs only

* Good — zero new endpoints.
* Bad — `grep [validator] | wc -l` is fine for a Friday afternoon, not for a recurring decision.

## Implementation notes

* **Ring buffer** is a plain `[]` with `splice(0, ring.length - capacity)` overflow. Simpler than a circular structure; the LOC + GC cost is rounding error.
* **Log format** for fires: `[validator] stage=… kind=… tools_called=… evidence=…`. Pre-OK calls are silent (would be too chatty — ~1 line per turn).
* **`evidence`** is sliced to 200 chars — enough to identify the fabrication, short enough to not blow logs.
* **`disabled: true` short-circuit** still records an entry so cross-period comparison works. The stat just says `kind: "ok"` for those entries; the `disabled` flag in the read endpoint distinguishes them from genuine clean-pass runs.
* **The actual validator code is unchanged** — this PR is purely a telemetry wrapper. A follow-up PR (post-telemetry-decision) will simplify or remove based on the data.

## Cross-references

ADR-0037 (the output validator itself). Bloat audit Tier-2 #10 (the source of this telemetry decision). The chat error card in ADR-0054 (which renders the persisted "⚠️ Output validator flagged…" footer when the retry budget is exhausted).
