---
status: accepted
date: 2026-06-03
deciders: example-user, claude
---

# Active-turn channel cue for scheduler / watcher / bridge inbound

## Context and Problem Statement

Three non-chat sources can deliver a turn to an agent: the scheduler (cron-like timed prompts), watchers (tool-result diffs that fire when a polled value changes), and bridges (external messaging adapters such as WhatsApp). All three funnel into the same `prepareThreadRun` entry point and persist a `messages` row with `role='user'` and a `category` tag — the data path is uniform with normal chat, and one thread per agent is already enforced by `idx_threads_agent_id` UNIQUE.

The user reported that "messages from scheduled task / watcher / bridge do not pass to the assigned agents correctly — the agent does not see them." Investigation showed both the inbound prompt and (eventual) assistant reply were appearing in the chat panel, but the assistant's reply repeatedly **ignored the content** of the inbound. Symptoms:

- Bridge messages — the LLM treated the `[bridge:…][chat_id:…]…` envelope as routing chrome and answered as if no question had been asked.
- Mixed-source threads (the same agent has both chat and a bridge route, or chat plus a scheduled task) — the LLM anchored on the most recent **plain-shape** turn and treated the envelope-wrapped inbound as background context.
- Silent scheduled tasks — the `[SILENT_TRIGGER] … reply NO_REPLY if nothing material …` wrapper inside the user-message body competed for the model's attention with the actual prompt, biasing toward NO_REPLY even on substantive prompts.

The framing was carried only inside the user-role message body. There was no system-prompt-side instruction telling the agent how the active turn arrived or how to read the envelope.

## Decision Drivers

* **No schema change.** The data layer is correct; only the prompt framing needs work.
* **Keep one-thread-per-agent.** This invariant already enforces the "primary thread" the user asked for — every source lands in the same thread the chat UI shows.
* **System-prompt > body wrapper for cross-cutting instructions.** Body wrappers compete with content; system-prompt blocks are isolated and the model treats them as governance.
* **Forward-compatible.** Adding a future channel (Telegram, Slack, email) should mean adding one more `case` to a switch, not redesigning the framing.

## Decision Outcome

Two coordinated changes, both shipping under ADR-0061.

### 1. `buildInboundChannelContext` system-prompt block

A new file-private helper in `lib/agents/prepare/system-prompt.ts` returns a category-specific block ("--- Active turn channel ---") and is slotted into `buildSystemPrompt` between the experience-mode block and the memory/tier blocks. The block tells the agent:

- Which channel delivered the active turn (bridge / watcher / scheduled task).
- The expected envelope shape inside the user-message body (where the metadata lives, where the raw text starts).
- That this **is** the active request, not background context.
- For silent scheduled tasks, the `NO_REPLY` rule and a "run the work first, decide afterward" guard so the agent doesn't short-circuit.

Plain chat (`category=null`) renders nothing — no behavioural change for the dominant case. Unknown categories also render nothing; a future `delegation` or `synthetic` cue can land as a new switch arm without breaking forward-compat clients.

### 2. Tighter envelope prose

- `lib/bridges/message-role.ts:roleNote` — every variant ends with an explicit "**This is your active request — respond to the raw text below the metadata block, not to the envelope itself.**" line. The `agent` echo case ends with `**This is NOT a request to respond to.**` for symmetry.
- `lib/triggers/handlers/watcher.ts:buildFiringPrompt` — the body now leads with "**Active turn — react to the change below.**" so the directive at the bottom isn't the only signal.

### 3. Silent wrapper migrates from body to system prompt

`lib/triggers/runner.ts` no longer staples `[SILENT_TRIGGER] … NO_REPLY …` into the user-message body. Instead, the runner forwards `silent: firing.silent === true` on `ThreadRunRequest`; the system-prompt cue (silent variant of the `scheduled_task` case) carries the rule. The bridge dispatcher does the same with its `route.silent_mode` flag. Post-run NO_REPLY detection on the assistant reply is unchanged.

## Consequences

**Pros**

- The agent has a stable, governance-tier instruction telling it how to read each channel; cross-source threads stop confusing the model.
- One source of truth for the silent rule (system prompt) rather than two competing copies (body wrapper + post-run sentinel detection).
- Adding a new channel is a one-arm switch addition.

**Cons / Trade-offs**

- The system prompt grows by ~3–6 lines whenever a non-chat turn fires. Inside the model's context budget this is well below the rounding error of any tier, but it is a real cost on plain-chat turns? — no: plain chat renders an empty block, so no cost there. Cost is paid only on turns that already came from a non-chat channel.
- The cue is keyed off `req.user_category`. Stall- and transient-retry recursions reuse the original request, so the cue stays consistent across the same turn's retries even though the synthetic nudge body is plain text — this is intentional: the LLM should still treat the original channel as the active framing for the whole retry chain.

**Out of scope**

- A separate per-channel system-prompt block on every turn (e.g. always remind the agent that bridges exist). The cue is gated on the active turn's category to avoid steady-state cost on chat-only agents.
- A new "primary thread" abstraction. The existing UNIQUE(agent_id) on threads already gives us this — the user's request resolved to a framing fix, not a schema fix.

## Verification

1. `npm run lint && npm run build` passes.
2. New unit coverage in `lib/agents/prepare/system-prompt.test.ts` — one case per category (chat null, bridge, watcher, scheduled_task, scheduled_task silent) asserts the cue block is present (or absent) and contains the category-specific phrasing.
3. Updated `lib/bridges/message-role.test.ts` covers the new "active request" tail line on each role-note variant.
4. Live smoke (`npm run dev`):
   - Bind a bridge route to an agent that also has chat history. Send an inbound; assistant reply addresses the body, not the envelope.
   - Fire a substantive scheduled task; assistant runs the task instead of replying NO_REPLY.
   - Toggle silent on a scheduled task with a no-op prompt; assistant replies NO_REPLY only when there is nothing material.
