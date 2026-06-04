---
status: accepted
date: 2026-06-03
deciders: andwu, claude
---

# Per-channel warm summary and source-attributed context

## Context and Problem Statement

ADR-0022 established a message-channel taxonomy (`user`, `assistant`,
`scheduled_task`, `watcher`, `bridge`, `synthetic`, …) and a per-agent
display filter so the chat UI can hide automation noise. ADR-0042 added a
single persisted `warm_summary` per thread so older history survives the
hot-window cap without being lost.

These two ADRs interact badly. Every `agent_id` has exactly one singleton
thread (`getOrCreateAgentThread`, `lib/stores/threads.ts`). Scheduled tasks,
watchers, and bridge inbounds all run against that same thread via
`runTriggerAgent` (`lib/triggers/runner.ts`). The thread's single
`warm_summary` therefore conflates **every channel** — backup logs,
automation summaries, doc-sweep findings, file moves — into one paragraph
that is fed verbatim into the system prompt of the user's next interactive
turn. The model free-associates from that warm context and replies off-topic
to short user prompts. The display-filter toolbar hides the rows in the UI
but does not change what the model sees.

Observed symptom (2026-06-03): a trivial user prompt ("hey", "reply with one
word") produced an unrelated, multi-paragraph reply derived entirely from
automation-channel history the user never asked about.

The shared thread is also a feature: the user wants to ask follow-ups about
things the automation surfaced ("what did the backup do?", "open that
ticket"). Splitting per-task throws that away.

How do we keep one thread per agent while preventing cross-channel context
pollution, and let the model know **where each piece of context came from**?

## Decision Drivers

* **Preserve the shared-thread product promise.** Follow-up questions across
  channels must keep working from one thread.
* **Stop cross-channel summary leakage.** A user's interactive turn must not
  be prompted with automation history it never asked for.
* **Source attribution.** The model should know whether a context block came
  from the user, a scheduled task, a watcher, a bridge, etc. — both to
  reason about trust and to answer "where did you see X?".
* **UI ⇔ model parity.** If the user has a channel hidden in the UI, the
  model should not silently pull it in. If the user turns it on, the model
  sees it on the next turn. ("What I see is what the agent sees.")
* **Additive, reversible schema change.** Single Next.js process invariant
  (CLAUDE.md). Existing threads must continue to work without backfill.
* **Bounded summarisation cost.** N channels must not mean N LLM calls per
  user turn — only the channels actually opted in this turn get
  (re-)summarised.

## Considered Options

* **(A) Per-channel warm summary, single thread.** Replace the one
  `warm_summary` column on `threads` with an additive
  `thread_channel_summaries` table keyed by `(thread_id, channel)`. Prompt
  assembly picks summaries by the *active channel set* for this turn,
  prefixed with a "Source: …" header so the model knows attribution. Hot
  window already carries `category` per message; just expose it inline as a
  `[source: scheduled_task @ 22:54]` prefix when channels are mixed.
* **(B) Per-task synthetic thread + firehose view.** Each trigger writes
  into its own thread; a virtual "all activity" view merges them for
  browsing. Hard isolation, but breaks the shared-thread feature.
* **(C) Drop the warm summary, hot window only.** Eliminates the leak by
  deleting the polluter. Loses long-horizon memory that ADR-0042 was
  introduced to preserve.
* **(D) One warm summary, but split *generation* prompt by channel.** Keep
  one summary column but ask the summariser to write distinct paragraphs
  per channel. No schema change. No real isolation either — still one blob
  going into every prompt.

## Decision Outcome

Chosen: **(A) Per-channel warm summary with attributed context.**

It is the only option that fixes the leak while keeping the shared-thread
follow-up feature intact, and the source-attribution requirement falls out
of the same change (you cannot route summaries by channel without naming
the channel; once named, you label it for the model too). (B) costs the
product feature. (C) regresses ADR-0042. (D) is theatre.

### Decision details

**Channel set per turn.** The active channel set for a turn is:

* On a user-initiated turn (`POST /threads/:id/run`): `{"chat"}` plus any
  channels the UI currently has toggled on in the thread's filter toolbar.
  The UI sends this as an explicit `channels: string[]` field on the run
  submission so server and client agree.
* On an automation-initiated turn (`runTriggerAgent`): exactly
  `{firing.category}` (the firing's own channel). Automation never pulls
  in other channels' summaries — its prompt is self-contained.

The pseudo-channel `"chat"` covers ordinary `category=NULL` user/assistant
messages.

**Default chip state.** New threads start with **all channels enabled** in
the filter toolbar — matches today's UI default and preserves the
shared-thread follow-up promise ("what did the backup do?" works without
the user first hunting for a toggle). The leak is fixed not by hiding
channels by default but by (a) splitting the summary per channel and (b)
labelling every block with its source so the model stops blending them.
Users who want a quiet, chat-only prompt mute channels explicitly; the UI
immediately reflects the same view the model will see on the next turn.

**Bridge channel.** `bridge` is bucketed with other automation channels
(`scheduled_task`, `watcher`) — same chip behaviour, same summary table
row, same `[source: bridge @ hh:mm]` prefix. It is *not* aliased to
`chat`, because bridge inbounds originate from a non-interactive surface
and the user benefits from knowing the message came in over a bridge
rather than from their own typing.

**Schema.** New table, additive:

```sql
CREATE TABLE thread_channel_summaries (
  thread_id    TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,
  summary      TEXT NOT NULL,
  summary_before  TEXT,            -- mirrors ADR-0042 freshness key (hot_since)
  computed_at  TEXT NOT NULL,
  PRIMARY KEY (thread_id, channel)
);
```

The existing `threads.warm_summary*` columns are kept for one release as a
read-only fallback (treated as the `"chat"` channel summary if no row
exists in the new table). A follow-up release deletes them once all live
threads have a row.

**Prompt assembly (in `buildHistoryWindow`).** Today's assembly is
roughly: `[system] [warm_summary?] [hot_messages] [user_turn]`. The new
shape is:

```
[system]
[for each ch in active channels, in deterministic order:
   "## Context — source: <ch>  (summary as of <computed_at>)"
   <summary>
]
[hot messages, each prefixed with "[<channel> @ <hh:mm>] " when more
 than one channel is active; bare otherwise]
[user_turn]
```

Hot messages already carry `category` in the row; the prefix is added at
assembly time, not at persistence time. When the active set is exactly
`{"chat"}` the output is byte-identical to today's (no labels).

**Summary freshness.** Each `(thread_id, channel)` row caches its own
`summary_before` against `hot_since`, mirroring ADR-0042. A summary is
fresh iff `summary_before === hot_since AND no new messages of that
channel since computed_at`. Stale or missing summaries are computed
lazily on the next turn that asks for that channel — so adding a new
channel toggle is at most one extra summarisation, not N.

**UI ⇔ model parity.** `useMessageFilters` (per-agent display filters from
ADR-0022) becomes the source of truth for the run submission's `channels`
field. Turning a chip on in the toolbar both reveals the rows and includes
that channel in the next turn's context. A new "i" tooltip on each chip
makes the dual meaning explicit: "show + include in next turn".

### Consequences

* Good — interactive turns see only the channels the user opted in to,
  ending the off-topic-reply class of failures described above.
* Good — the model knows where each block came from and can cite it
  ("from the 22:54 scheduled task …"), which makes the shared-thread
  follow-up feature actually usable.
* Good — UI filter chips become honest: hiding a channel removes it from
  the model's view too.
* Good — additive schema. Existing threads keep working via the
  fallback-read; rollback = stop reading the new table.
* Bad — assembly is slightly more complex (channel-prefix logic, sort
  order). Mitigated by a single small helper and golden-file tests on
  the assembled prompt.
* Bad — adding a new channel toggle mid-thread can trigger one extra
  summarisation before the reply streams. Same cost shape as ADR-0042's
  pin-move; acceptable.
* Bad — runs whose `channels` set changes across turns will not enjoy
  perfect cache hit rate. Accepted: opt-in is a deliberate user action.

## Pros and Cons of the Options

### (A) Per-channel warm summary (chosen)

* Good — fixes the leak at the only place that actually feeds the model.
* Good — source attribution emerges naturally and is useful in its own
  right.
* Neutral — one new table, one new field on the run-submit payload, one
  changed helper in assembly.
* Bad — N channels means N cached summaries (bounded by the taxonomy,
  not by row count).

### (B) Per-task synthetic thread

* Good — total isolation; impossible to leak.
* Bad — kills inline follow-up; sidebar grows unbounded; cross-channel
  questions need a new tool.
* Bad — requires migrating every scheduler / watcher / bridge call site.

### (C) Drop the warm summary

* Good — trivially correct; deletes code.
* Bad — regresses ADR-0042; loses long-horizon memory across compactions.

### (D) Single column, multi-paragraph summariser

* Good — zero schema change.
* Bad — does not actually isolate; the blob still lands in every prompt.

## More Information

* Supersedes the single-column warm-summary half of ADR-0042 (pin
  semantics survive unchanged).
* Builds on ADR-0022 (channel taxonomy) — same channel keys, same
  per-agent filter store.
* Related: ADR-0039 (`prepareThreadRun` decomposition — `channels`
  threads through the same call site as `hot_since`).
* Follow-up (not in this ADR): once the new table is fully populated,
  drop `threads.warm_summary*` columns in a separate migration ADR.
