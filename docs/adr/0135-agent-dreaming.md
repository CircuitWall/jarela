# ADR-0135: Agent dreaming — idle consolidation and weekly maintenance

Status: **Accepted**

Date: 2026-11-26

Related: [ADR-0042](./0042-thread-context-pin.md) (thread context pin),
[ADR-0044](./0044-per-channel-warm-summary-and-attributed-context.md) (channel
summaries), [ADR-0096](./0096-exact-context-boundary.md) (exact boundary and
warm-context service), [ADR-0024](./0024-document-rag.md) (document index),
[ADR-0133](./0133-document-index-lifecycle.md) (document index lifecycle),
[ADR-0134](./0134-document-embedding-blob-storage.md) (embedding storage),
[ADR-0117](./0117-bounded-database-migrations.md) (bounded migrations).

## Context

Jarela already has the pieces of consolidation but no proactive trigger:

- A thread that has been silent for three hours gets a *hint* in the system
  prompt. The model must ask the user whether to continue; only an explicit
  "start fresh" calls `compact_context` and moves the context boundary. The
  runtime deliberately does not guess at wake time because topic-shift
  detection is unreliable on short openers.
- Turn-driven auto-boundary compaction and the 1,000-message retention cap
  handle active and oversized threads. Neither reacts to idleness.
- Memory maintenance (`memory_audit` / `memory_apply_maintenance`) is a manual
  tool. The document index has a 10-minute reindex sweep and a bounded
  lifecycle sweep, but neither runs a weekly consolidation.
- There is no durable record of what background consolidation did, how much it
  cost, or why it was skipped.

The product gap is a **sleep cycle**: after a period of inactivity an agent
should wake with a clean hot context, and the installation should periodically
maintain the shared memory and knowledge stores without asking the user.

## Decision

1. **Two dream depths.** Every agent gets an idle-triggered *light dream*:
   compact the thread context without pruning history. The default agent also
   owns a weekly *deep dream* that maintains the shared memory and knowledge
   stores, because those stores are installation-wide and must not be
   maintained concurrently by every agent.
2. **Light dreams replace the three-hour question, not the history.** At the
   configured idle threshold (default 3 hours) the runtime anchors at the last
   completed user turn and moves the context boundary through the existing
   exact-boundary service. The topic-aware warm summary is built first and the
   boundary plus its coverage cursors commit together; an empty recap is a
   failed pass, not a reason to drop context. Messages are never deleted by a
   light dream; retention stays cap-driven.
3. **A light dream is a compaction kind, not a second coordinator.**
   `CompactionKind` gains `dream`, so the existing tracked-attempt, timeout,
   single-flight, compare-and-set, and queued-boundary machinery applies
   unchanged. `pendingCompactionBoundarySeq` and the background-compaction
   guard include it, so an automatic boundary and a dream cannot race.
4. **A zero-token preflight decides whether a dream is needed.** The scheduler
   evaluates persisted thread state before any model call:
   - no running turn, queued turn, or compaction on the thread;
   - the master key is unlocked and a runnable model exists;
   - the thread has been idle for the threshold;
   - at least two foreground user turns exist after the current boundary;
   - the thread has not already dreamed this idle window;
   - the per-agent daily run and estimated-token budgets are not exhausted.
   Every skip has a reason recorded in the run journal or the readiness
   response. A skipped evaluation costs no provider tokens.
5. **Deep dreams are deterministic first, with explicit model merge calls.**
   Once a week, at a local weekday and hour, the default agent archives expired
   facts, archives exact duplicate facts, refreshes stale embeddings, rewrites
   legacy document embeddings, and reclaims free pages. Each phase is bounded
   and resumable where the underlying operation is resumable.
   After the deterministic memory pass, near-duplicate groups in `facts` get an
   explicit model merge call (`deep_merge_enabled`, at most five groups by
   default). The model returns a strict JSON proposal; code validates the
   survivor key, schema, confidence floor, expiry agreement and fingerprint, and
   only then runs a dry-run and applies `upsert` plus `archive` operations. The
   survivor keeps revision history, every duplicate is archived rather than
   deleted, and permanent deletion never happens without an explicit user
   action. A short model-written consolidation note is optional and clearly
   labeled as model-generated; it never writes facts. The document phases and
   model calls are bounded by wall-clock budgets; the memory scans are bounded
   synchronous passes that run only after the installation has been idle.
6. **Dream state is bounded and auditable.** `agent_dream_state` stores the
   per-agent opt-out, the last light/deep success, the last attempt, the last
   committed light boundary, and the last error. `agent_dream_runs` stores one
   row per executed dream with kind, status, summary, estimated input/output
   tokens, bounded stats JSON, and error. Runs are retained for 90 days and at
   most 200 per agent. The journal is silent: dreams do not write chat rows,
   publish notifications, or create scheduled-task entries.
7. **Budgets are ceilings, not targets.** Defaults are deliberately generous:
   250,000 estimated tokens per agent per day for light dreams and 500,000
   estimated tokens per week for all deep model work (merge calls and the
   weekly note). Token counts are estimated
   from transcript and summary characters because `provider.chat` exposes no
   usage stream; the journal labels them as estimates. Wall-clock budgets bound
   the document rewrite and reclaim phases. Exhaustion marks a run `partial`
   and keeps every change already applied.
8. **Money, safety, and availability gates come first.** A dream never runs
   while the app is locked, while a turn or compaction is active, while a
   document-index maintenance action is running, or while another dream is
   running. The scheduler starts at most one dream globally at a time. All
   model calls are abortable and bounded by the compaction deadline. A manual
   trigger may bypass the idle clock, the weekly due time, and retry/daily
   limits, but never the lock, a busy thread, another dream, or the token
   budget.

### Data model

```sql
agent_dream_state(
  agent_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_light_dream_at TEXT,
  last_light_attempt_at TEXT,
  last_light_boundary_seq INTEGER,
  last_deep_dream_at TEXT,
  last_deep_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

agent_dream_runs(
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- light | deep
  status TEXT NOT NULL,        -- running | completed | partial | failed | skipped
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT,
  stats TEXT,                  -- bounded JSON
  estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_output_tokens INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
```

The migration also adds a partial `messages(created_at DESC)` index for
foreground user rows, so the deep-dream idle check does not scan backwards
through scheduled-task and watcher traffic.

Both tables are additive and rollback-safe. They deliberately do **not** use a
foreign key to `agent_configs`: that table is written with `INSERT OR REPLACE`,
which deletes and re-inserts the row, so a cascading FK would erase an agent's
dream state every time the user edited its instructions. The swarm instead
prunes dream rows whose agent no longer exists. A running row left by a crash is
recovered as `failed` after the compaction deadline so the journal never shows
a permanently running dream.

### Scheduling

The existing 30-second scheduler evaluates dreaming every tenth tick. On the
first tick after boot it evaluates immediately, so a missed weekly slot is
caught up as soon as the installation is idle. A missed deep dream is not
replayed once per missed week; one catch-up run covers the current maintenance
pass.

Light dream: idle threshold in minutes, at least two foreground user turns
after the boundary, at most six started attempts per agent per local day, and
the daily estimated-token ceiling.

Deep dream: local weekday (0 = Sunday) and hour (default Sunday 03:00), at
least fifteen minutes since the newest foreground user turn, no active runs
globally, and a six-hour retry cooldown after a failed attempt. A deep dream that would be due
runs at the next eligible idle window.

## Consequences

- After the idle threshold, the next user turn no longer receives a
  "Conversation gap" question. The agent wakes with a warm recap and a clean hot
  window. The client's old in-chat three-hour question is hidden while dreaming
  is enabled for the agent, and the system-prompt gap hint is suppressed once a
  boundary and its matching recap are committed. Both remain only as fallbacks
  when dreaming is disabled or a dream could not run.
- Idle compaction is cheaper than the previous turn-time summarisation: it
  runs once per idle window instead of re-checking on every turn, and the
  preflight avoids the paid topic-boundary call when the boundary is current.
- Light dreams do not shrink the database. Only the explicit document lifecycle
  actions and the weekly deep dream reclaim space.
- The default agent becomes the single owner of shared-store maintenance. If
  the default agent is deleted, deep dreaming pauses until another agent is
  marked default.
- Estimated token accounting is conservative but not exact. Real provider
  usage remains authoritative; the journal says so.
- Explicit merge calls can still choose imperfect wording; the code-enforced
  guards (same kind/subject, expiry agreement, weakest confidence, schema and
  fingerprint checks, archive-only) prevent structural loss, and every prior
  value remains recoverable from the archived row or revision history.
- Model-assisted replay of archived sessions is not part of this decision. The
  deterministic phases, explicit merges, and weekly note ship first; a later
  amendment can add replay under the same weekly budget and validation rules.

## Alternatives considered

- **A generic scheduled task for dreaming.** Rejected: scheduled tasks are
  user-owned automations that create chat rows, notifications, and task-list
  entries. A dream must be silent, installation-wide, and able to preempt
  itself based on idle state.
- **Always compact at the next turn when a gap is detected.** Rejected: the
  existing gap hint's rationale still holds — the runtime cannot reliably
  infer intent from a short opener. Compacting *before* the turn avoids the
  guess entirely.
- **Prune history during a light dream.** Rejected: compaction and retention
  are separate decisions. Pruning under an idle trigger would destroy rows the
  retention cap intentionally kept.
- **Run memory and document maintenance for every agent.** Rejected: the
  stores are shared; concurrent audits, bulk archives, and vacuums would race
  and multiply cost. The default agent owns global maintenance.
- **Leave near-duplicate merging entirely manual.** Rejected: common wording
  drift then accumulates forever, and the weekly dream cannot reduce the most
  common memory noise. Explicit merge calls keep the judgment step but bound it,
  validate it in code, and archive rather than delete.
- **Apply model merge output without code validation.** Rejected: the model is
  not trusted to pick keys, keep provenance, respect expiry, or preserve the
  weakest confidence. Every write goes through the memory maintenance guards.
- **Delete duplicate records after merging.** Rejected: archive preserves the
  old value and revision history for recovery.
- **Run the deep dream at a fixed calendar time regardless of activity.**
  Rejected: a multi-minute maintenance pass at 03:00 while the user is chatting
  is worse than waiting for the next idle window. The weekly slot is a
  not-before time, not a guaranteed time.
- **Use `automation_activity` as the journal.** Rejected: those rows are chat
  messages, so writing them would change the transcript, wake the thread, and
  defeat the idle check.

## Validation

- `lib/agents/dreaming.test.ts` covers light-dream eligibility and every skip
  reason, boundary selection, the already-compacted preflight, daily and token
  budgets, deep-dream scheduling and catch-up, deterministic maintenance
  phases, explicit merge acceptance/decline paths, merge validation,
  archived-duplicate recovery, provider failure isolation, and
  concurrent-trigger rejection.
- `lib/stores/agent-dreams.test.ts` covers state creation, opt-out, run
  lifecycle, token sums, retention, and interrupted-run recovery.
- `lib/db/versioned-migrations.test.ts` and
  `lib/db/deferred-migrations.test.ts` cover the additive migration and the
  frozen fixture.
- `app/api/v1/dreaming/route.test.ts` covers validation, settings persistence,
  per-agent opt-out, missing agents, and conflict responses.
- The Knowledge-panel Dreams section is covered by a controller/component test
  and the existing UI data-access ratchet.
