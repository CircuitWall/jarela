---
status: accepted
date: 2026-06-02
deciders: andwu, claude
---

# Surface warm-summary failure as a first-class compaction status

## Context and Problem Statement

The warm tier (ADR-0042 / ADR-0043) compresses messages older than the hot boundary into an LLM-generated recap. Today the summariser is a single-shot call wrapped in `try/catch`: any provider hiccup — transient network blip, content-filter trigger on a benign turn, expired credential — falls into the catch and returns `""`. The history-window then either reuses the prior cached summary (when the boundary hasn't moved) or falls back to truncating the largest hot messages. Either way, the user sees no indication that compaction degraded: the chat keeps streaming, the agent keeps replying, and over a long task its sense of "what was decided 30 turns ago" silently erodes.

This is the worst-case failure mode for the new product directive ("reliably handle long, complex tasks"). The user invests dozens of turns into a task whose continuity depends on the warm summary; a single flaky compaction turn corrupts it without any signal.

## Decision Drivers

* **Loud failure on degradation.** Users must be able to see when warm context is failing so they can react (retry, switch model, trim history) before the agent's understanding drifts further.
* **Don't make every turn pay double.** A 2x cost on the steady-state turn (always retry) is unacceptable. The retry budget must be small and bounded.
* **Don't lose existing cached summaries.** When the new attempt fails, the prior summary on the thread is better than nothing — keep it, flag the status.
* **Stay within the existing schema.** Adding a new top-level table or a new transport leg is over-engineering; the `threads` row is the right place.

## Considered Options

### Failure-handling strategies

* **(A) Status quo — empty string on error, no signal.**
* **(B) Retry-once on the same provider/model + persist a thread-level status.**
* **(C) Retry-once + fall-back to a smaller model + persist status.** Adds a second provider dependency and a fast-model selection policy.

### Surfacing strategies

* **(α) Banner chip in ChatView when `warm_summary_status === "failed"`.** Persistent until next successful summarisation.
* **(β) Toast notification on each failure.** Transient.
* **(γ) Per-message indicator in the existing context-usage bar.**

## Decision Outcome

Chosen options: **(B) retry-once + persisted status** and **(α) ChatView banner chip + (γ) per-row tier-starvation hint inside the existing bar**.

(B) ride-throughs the dominant failure mode (transient network) without the steady-state 2× cost (C) implies. Adding a fast-model fallback is a future ADR if real-world telemetry shows we need it.

(α) is the headline signal — the user can't miss it once compaction fails. (γ) catches the per-turn case where compaction returned a result but the warm tier still came back near-empty (long task with mostly hot content, etc.) — it's complementary, not redundant.

### Consequences

* Good — silent compaction failure is now impossible: at minimum, a banner chip surfaces.
* Good — the prior cached summary stays intact when retry exhausts, so the agent isn't strictly worse off than before.
* Good — `warm_summary_status` is queryable, so future automations (e.g. auto-switch to a smaller model, auto-trim history) have a hook.
* Bad — adds a column to `threads`. Mitigated by the migration being idempotent (matches the ADR-0042 pattern).
* Bad — the chip uses precious banner real estate. Mitigated by appearing only on `failed` status; the `fresh` and NULL cases render nothing.
* Bad — the retry doubles the cost of a turn that *would have* failed silently. We consider this a feature: the user pays once to know whether their task is operating on solid context.

## Pros and Cons of the Options

### (B) Retry-once + persisted status (chosen)

* Good — covers the dominant failure mode (transient network) with bounded extra cost.
* Good — leaves room for (C) later as a follow-up ADR without re-shaping the data model.
* Neutral — retry latency is small (250 ms default delay between attempts).

### (C) Retry + fast-model fallback

* Good — recovers from per-model failures (provider down, account quota exhausted on the primary model).
* Bad — requires a fast-model selection policy. Not implemented today; would need its own ADR.
* Bad — risks producing a noticeably-different summary style mid-task, confusing the agent.

### (A) Status quo

* Good — no work.
* Bad — the entire point of this ADR is that this fails the long-task directive.

### (α) Banner chip (chosen)

* Good — impossible to miss; persistent until resolved.
* Good — actionable: tooltip explains what to check.
* Neutral — UI real-estate cost is small (one row, only when failed).

### (β) Toast notification

* Good — out of the way once dismissed.
* Bad — easy to miss. The user might not see the toast and operate on a corrupted warm context for many more turns.

### (γ) Per-row tier-starvation hint (chosen — complementary)

* Good — surfaces per-turn starvation that isn't strictly a "failed" signal but still matters: warm or facts tier was budgeted but came back near-empty.
* Good — lives inside the existing details panel; only shown when expanded.
* Neutral — heuristic threshold (10% of budget) — may need tuning based on usage.

## Implementation notes

* New column `threads.warm_summary_status TEXT`, idempotent ALTER in `ensureThreadContextPinColumns`. Values: `'fresh' | 'stale' | 'failed'` or NULL on legacy / never-engaged threads. `'stale'` is reserved for a future "boundary moved but haven't recomputed yet" signal.
* `summarizeTranscriptWithRetry` in `lib/agents/conversation-summary.ts` wraps the existing `summarizeTranscript` with a 2-attempt budget and 250 ms inter-attempt delay. Returns `{text, attempts, lastError}` so the caller can persist status + log the underlying error.
* `lib/agents/prepare/history-window.ts` calls the retry-aware variant, returns a `WarmSummaryOutcome` with `text` + `status`, and persists the outcome via `setThreadWarmSummary` (success path, also stamps `'fresh'`) or `setThreadWarmSummaryStatus` (failure path, leaves the prior cached summary untouched).
* `ResolvedHistoryWindow.warmSummaryStatus` makes the per-turn outcome available to the route. Today this is plumbed via the thread row directly (cheap); a follow-up could persist it on `message_usage` for historical context.
* `app/api/v1/threads/[thread_id]/context-pin/route.ts` and the thread-detail GET (`...thread` spread) return the status; the chat client reads it on every refresh.
* `ContextUsageBar` adds the per-row tier-starvation hint inside the expandable details panel.
* `ChatView` renders a banner chip whenever the active thread's `warm_summary_status === "failed"`. The chip clears on the next successful summarisation (`setThreadWarmSummary` flips status back to `'fresh'`).
* Cross-references: ADR-0042 (boundary pin + cached summary, the column layout this extends), ADR-0043 (per-agent tier proportions, what governs the warm budget), ADR-0044 (stream-chunk schema, the per-turn telemetry plumbing this rides on).
