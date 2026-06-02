---
status: accepted
date: 2026-06-02
deciders: example-user, claude
---

# Durable task memory: pinned task goal + automatic fact graduation

## Context and Problem Statement

The product directive is to "reliably handle long, complex tasks." With the tiered context (ADR-0042 / ADR-0043) and the warm-summary retry hardening (ADR-0045) the chat survives ~hours of work without losing turns. But two structural failures still corrupt long tasks even when nothing is technically broken:

**1. The original task description gets compacted away.** It lives in the user's first turn. After enough hot history accumulates the boundary slides past it; from then on the agent is operating on a warm-summary recap of "the user wanted X, then asked Y, then said Z" with the *original goal* compressed into a single sentence (or dropped entirely). The agent's north star drifts.

**2. Recurring facts re-summarise forever instead of graduating.** Every time the warm boundary moves, the same key facts ("user prefers TypeScript", "deploy target is `prod-eu1`", "ticket ABC-123 covers this") get re-summarised into the recap. They consume warm budget every turn and compete with whatever's actually new. They should leave the warm tier and live in long-term `memory_store namespace=facts`, where they're recallable on demand and don't crowd out per-turn signal.

Both problems are about *placement* — what should live in which tier so a long task doesn't lose continuity. Neither is solved by adding more compaction tooling; both are solved by adding storage tiers above warm that compaction can't touch.

## Decision Drivers

* **Long-task continuity must survive compaction.** A 200-turn task that loses its goal halfway through is a worse failure than a crash — the user can't even tell when drift started.
* **Don't pay extra LLM cost on every turn.** Goal injection is free (one DB read, ~400 tokens). Fact extraction is one LLM call but only on boundary moves (not every turn) — same trigger as warm summarisation.
* **Be conservative on what gets persisted.** A fact stored in long-term memory is harder to evict than one that hangs around in warm; better to miss a fact than store a hallucinated one.
* **Stay within the existing data model.** New tables / new processes are over-engineering; `threads.task_goal` and `memory_store namespace=facts` already fit cleanly.

## Considered Options

### Goal pin

* **(A) Status quo — first user turn carries the goal forever.** Compaction eats it eventually.
* **(B) Auto-extract a goal from the first turn into a hidden field.** Convenient but error-prone; a misextraction silently corrupts long tasks.
* **(C) Explicit user-pinned goal via `/goal` slash command.** Predictable; the user controls what counts.

### Fact graduation

* **(α) Status quo — facts live in warm forever.** Re-summarised every boundary move.
* **(β) Per-turn extraction.** Catches facts as they're stated. Doubles LLM cost on every turn.
* **(γ) Boundary-move extraction.** Same trigger as warm summarisation; extraction runs against the messages-being-evicted. One extra LLM call per move, no extra cost on steady-state turns.
* **(δ) Heuristic / regex extraction.** No LLM call. Misses anything not matching a hand-coded pattern.

## Decision Outcome

Chosen options: **(C) explicit `/goal` pin** and **(γ) boundary-move LLM extraction with a high confidence threshold**.

(C) is the right tradeoff because the goal is *the* most load-bearing piece of context in a long task — automatic guesses are unacceptable. The friction of typing `/goal Build the Foo feature` is one-time-per-task and the user is already typing prose at the agent.

(γ) ride-shares the existing boundary-move trigger. The summariser already runs an LLM call against the evicted messages; adding a second call with a different prompt is small additional latency and zero additional turns-with-LLM-calls. The 0.75 confidence threshold and string-length caps keep memory_store clean even when the model overgenerates.

### Consequences

* Good — the agent's north star survives any amount of compaction. A 500-turn task started with `/goal X` still sees `--- Task goal ---: X` on turn 500.
* Good — recurring facts move out of warm into facts memory after one boundary move, freeing warm budget for genuinely new content.
* Good — both features compose with ADR-0042's pin and ADR-0045's status — task_goal sits *above* the tiers; compaction degradation is a tier-internal problem.
* Good — no new tables or processes; both changes are additive columns + one new module.
* Bad — adds a column to `threads`. Mitigated by the migration being idempotent (matches the ADR-0042 pattern).
* Bad — fact extraction adds an LLM call on each boundary move. Mitigated by sharing the same trigger as the summariser, so users who don't move the boundary don't pay it. Cost is also bounded by the 1024-token output cap and a 6-fact-target prompt.
* Bad — extracted facts can collide with user-written facts in `memory_store`. Mitigated by keying on snake_case identifiers (the model is told to keep them descriptive) and by the upsert-by-(namespace, key) semantics — the latest write wins, which is the desired behaviour anyway.

## Pros and Cons of the Options

### (C) Explicit `/goal` pin (chosen)

* Good — user controls the goal text exactly; no extraction errors.
* Good — discoverable: `/goal alone` clears, `/goal <text>` sets. Same UX shape as the existing `/new`.
* Good — visible: chip near input shows the active goal so the user knows it's pinned.
* Neutral — one-time friction at task start. Acceptable for tasks long enough to benefit.

### (B) Auto-extract from first turn

* Good — zero friction.
* Bad — false-positive risk. If the first turn is "hi, can you help me?" we'd pin garbage as the goal forever.
* Bad — invisible to the user; they wouldn't know what the agent thinks the goal is.

### (γ) Boundary-move LLM extraction (chosen)

* Good — shares the existing summariser trigger; no extra "free improvement that always runs" cost.
* Good — high-confidence threshold (0.75) keeps memory clean even on a chatty model.
* Neutral — facts extracted from a 5-turn evicted slice are usually high-signal; from a 50-turn slice they're noisier (already covered by the chunked input cap).

### (β) Per-turn extraction

* Good — catches facts as they're stated, before any compaction.
* Bad — doubles per-turn LLM cost. Strictly worse than (γ) when the warm tier is doing its job.

### (δ) Heuristic / regex

* Good — free.
* Bad — misses anything that wasn't hand-coded. The point of the LLM era is we can replace fragile heuristics with prompts.

## Implementation notes

* New column `threads.task_goal TEXT`, idempotent ALTER in `ensureThreadContextPinColumns`. NULL = no goal pinned.
* `setThreadTaskGoal(thread_id, goal | null)` in `lib/stores/threads.ts`. Trims and caps at 1500 chars.
* `PATCH /api/v1/threads/:id/task-goal` accepts `{task_goal: string | null}`. Returns the persisted value.
* `lib/agents/prepare/system-prompt.ts#buildTaskGoalContext` renders `--- Task goal ---` as the *first* block in the system prompt, above identity/instructions, so the model orients to it before anything else. This block is OUTSIDE the tier budget — any compaction operates on history, not on the system prompt.
* `lib/agents/fact-extraction.ts` defines `extractFactsFromTranscript()` and `parseFactList()`. The LLM is instructed to return ONLY a JSON array of `{key, value, confidence}`. Best-effort: parse failure / model error / empty array all produce a no-op. Filter at `FACT_CONFIDENCE_THRESHOLD = 0.75`.
* `lib/agents/prepare/history-window.ts#graduateFactsFromEvicted()` calls extraction at the same boundary-move trigger as the summariser, persists qualifying facts via `putMemory("facts", key, value)`. Idempotent: re-graduating the same fact across moves just refreshes its updated_at and re-embeds.
* Chat UI: `/goal <text>` slash command in ChatView (sibling to `/new`); chip near InputBar with a "clear" affordance; chip is hidden when `task_goal` is null.
* Cross-references: ADR-0042 (per-thread context pin — boundary trigger this rides on), ADR-0045 (warm-summary retry — this is the long-term sibling: when summary degrades, facts memory still has what graduated), ADR-0044 (stream-chunk schema — orthogonal, transport layer).
