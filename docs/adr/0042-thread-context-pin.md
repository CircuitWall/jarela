---
status: accepted
date: 2026-06-01
deciders: example-user, claude
---

# Per-thread context pin with persisted warm summary

## Context and Problem Statement

The chat UI's pagination and the agent's `buildHistoryWindow` are decoupled today: the user scrolls freely for re-reading, while the agent computes its hot/warm/facts split independently from `agentCfg.history_limit` + `history_window_hours`. The warm summary is hidden — it only ever appears in the system prompt, never in the chat. So the user can't tell what the agent has summarised away, and has no lever to extend the hot context for an answer that needs older messages.

How should we let the user see and control where the agent's hot context begins, without conflating UI navigation (re-reading) with token spend?

## Decision Drivers

* **Token cost transparency.** Coupling chat scroll to hot context (the original ask) means casual scroll-up costs LLM tokens; users have no way to know.
* **LLM quality.** Diluting the prompt with stale, off-topic messages hurts answer quality. Today's "last 50 / 8h" cap reflects that empirically.
* **Persistence + cross-device.** The user's choice should survive reload and apply on whichever device they next open the thread.
* **No new daemon, no schema explosion.** The repo runs as a single Next.js process (CLAUDE.md invariant). Schema additions need ADRs (project rule).
* **Ship-as-additive.** The feature must be non-breaking: existing threads with no pin behave exactly as before.

## Considered Options

* **(A) Scroll-coupled hot context.** Whatever's loaded in the chat = the next turn's hot set. Simplest mental model.
* **(B) Explicit context boundary line.** Chat pagination stays free (cheap, no LLM cost). A visible line in the chat marks the hot/warm boundary. The user clicks/drags to extend context. The warm-summary card sits above the line.
* **(C) Hybrid: scroll-coupled with a token-cost meter.** Couple scroll → hot, but surface a visible cost hint as the user scrolls past the cheap zone.

## Decision Outcome

Chosen option: **(B) Explicit context boundary line**.

It's the only option that decouples re-reading from context cost. Users scroll freely for reference; the agent's hot set only changes when the user explicitly opts in. The warm summary is finally visible to the user, which is the second half of the request. (A) trades user agency for simplicity but creates surprise costs. (C) is (A) with extra UI; the cost-meter doesn't actually prevent the cost.

### Consequences

* Good — chat navigation stays free; LLM cost only grows on explicit opt-in.
* Good — the warm summary is now a first-class artefact in the chat, not an invisible system-prompt block.
* Good — the boundary persists per thread, surviving reload and cross-device.
* Bad — extra UI affordance to discover (a line + a card). Mitigated by giving the line a clear chip label and matching the existing token system so it doesn't feel foreign.
* Bad — when the boundary moves, the cached summary is invalidated and the next send re-summarises (one extra LLM call before reply starts streaming). Acceptable: it's the same call profile as today's silent warm summariser, just more deliberate.

## Pros and Cons of the Options

### (A) Scroll-coupled hot context

* Good — minimum mental model: "what I see is what the agent sees".
* Bad — re-reading old messages silently inflates token cost.
* Bad — over-large hot windows demonstrably hurt LLM answer quality on stale context.
* Bad — no good way to communicate "this scroll position will cost you 3× more next turn".

### (B) Explicit context boundary line (chosen)

* Good — separates two distinct user intents (navigate vs include-in-context).
* Good — gives the warm summary a visible home in the chat.
* Neutral — needs a small new UI primitive (the divider + card) and one new endpoint (`PATCH /threads/:id/context-pin`).
* Bad — the user has to learn the affordance once. Mitigated with a clear chip label "drag up to include more".

### (C) Hybrid

* Good — preserves the simple "scroll = include" model.
* Bad — still has scroll-cost coupling; the meter is awareness-only, not control. Worst of both.

## Implementation notes

* Persistence: four nullable columns on `threads` (`hot_since`, `warm_summary`, `warm_summary_before`, `warm_summary_computed_at`). No new table — there is exactly one boundary and one cached summary per thread.
* Freshness: the cached summary is fresh iff `warm_summary_before === hot_since`. `setThreadContextPin` does not invalidate; the next `buildHistoryWindow` checks the equality and re-summarises lazily on send.
* API: `POST /threads/:id/run` gains an optional `hot_since` field (server writes it through to the column). New `PATCH /threads/:id/context-pin` lets the UI move the boundary without sending a turn.
* Cross-references: ADR-0039 (history-window decomposition — this PR threads `hot_since` through the same call sites). ADR-0008 (run command/query split — `PATCH context-pin` is a third command, kept tiny).
