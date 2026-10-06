# Runtime Signals Integration Audit

Baseline: local commit `1012ae1e`, PR #614 implementation. This audit used
isolated temporary app state and synthetic data, not the installed database.
No real provider, CLI delegate, process restart, or external write was run.

## Polishing Resolution: 2026-10-07

The findings below record the original baseline. The polishing pass converted
their reproductions into desired-behavior regressions and added a full-flow
suite using real SQLite, encryption, LangGraph, model/tool adapters, proxy,
queues, transcript commits, and the notification bus. Only external model
responses and CLI process execution are simulated.

| Original finding | Correction | Automated evidence |
| --- | --- | --- |
| Oversized result leakage | Owned success/error output stays encrypted; virtual references enforce ownership; paging fits the encoded transport budget and cannot re-spill plaintext | Real executor paging, peer denial, UTF-8, consume, expiry/deletion, empty spill-directory checks |
| Proxy context loss | Trusted continuation, permission, delegation, credential, and cancellation context survives execution; completion reads cannot spawn another task | Real proxy/LangGraph retrieval and no-extra-operation assertion |
| Approval/backlog rollback | Capacity is reserved before application; duplicate approval and late denial are fenced; terminal outcomes cannot be overwritten | Saturated reserved capacity, duplicate reservation, denial-race regressions |
| Result without event | Owned result and event commit atomically; the existing sweeper performs bounded settlement retries | Event-insert failure rollback and recovery injection |
| Timeout publication loss | Timeout settlement uses the same failure-safe atomic/retry path | Durable-write failure followed by timeout outcome recovery |
| Stranded transcript leases | Transcript/ack commit has one owner and releases promptly on persistence failure; stale lease commits fail | Actual assistant-insert rejection and ready-state verification |
| Native delegates outside contract | Claude/Codex terminal/failure/cancel callbacks use shared owned results; Codex tracking is reserved before spawning | Native job callback/cancel/late-completion tests and existing adapter tests |

The second code review additionally repaired process-wide state consistency
across Next route bundles (result cache/settlements, queues, active registry,
cold-attach waiters, and config invalidation), UTF-8 page boundaries, oversized
storage-budget handling, inherited raw native-status output, changed-target
wake loops, and cached result revocation. Module-reload regressions exercise
the same classes of failure that per-module unit tests missed.

Final transport review reproduced two further plaintext-spill paths: JSON
escaping can expand a small raw result past the budget, and a proxy envelope
can push a near-budget protected page over it. Selection now measures the
encoded response; consumption follows the returned shape. The proxy reserves
its exact envelope overhead through trusted runtime context, and the leaf
reader uses the remaining budget. Real wrapped-executor regressions cover
success/error escaping and proxy pages at 16 KiB and 1 KiB without spill files.

No unresolved blocking defect was found in the final scoped review. Permanent
storage failure is still a limit: after bounded settlement attempts, the live
cache reports an unknown outcome; restart reconciliation repairs the accepted
operation, but output never durably committed cannot be recovered.

The scripted offline provider deliberately requests a forbidden restart in
the real LangGraph loop. The framework refuses it, creates no new restart
operation, and still commits the completion response/ack. The test explicitly
blocks network requests and process exits.

These are automated closures, not a claim of live-provider compliance or
production fault tolerance. A supervised restart/PIN-unlock trial, process-kill
tests, and sustained load remain release-validation work. The PR stays draft.

## Findings

### P1: Oversized results bypass encryption and thread isolation

The async key path enforces the result's owning thread, but the `result_ref`
path calls the generic file reader before checking ownership. Results over
the inline limit spill as plaintext files, while only the reference envelope
is encrypted in SQLite.

Sources: [reference retrieval](../../lib/tools/support/async-results-tool.ts#L51),
[spill creation](../../lib/tools/support/result-refs.ts#L43), and
[plaintext file write](../../lib/attachments/spill.ts#L72).

Reproduced: create a synthetic result larger than 16 KiB in thread A. Thread B
cannot retrieve its async key, but can retrieve its `result_ref.name`. The
same synthetic contents are readable directly from the spilled file.

Required closure: owner-scoped encrypted large-result storage and authorized
reference retrieval, including paging, expiry, consume, and restart tests.

### P1: Proxy execution loses continuation context

`invoke_tool` forwards thread and credential context, but not the runtime's
completion flag. `executeTool` constructs a new config with only `thread_id`.
A read-only completion turn invoking an async read through the proxy therefore
creates a new wake-eligible operation. The intended recursive-wake suppression
does not apply on this path.

Sources: [proxy forwarding](../../lib/tools/system/invoke-tool.ts#L201) and
[runtime config reconstruction](../../lib/tools/runtime/runtime.ts#L224).

Reproduced: proxy `tool_result_get` with `async_run=true` from a completion
config. Its new operation records `wake_eligible=true` instead of false.

Required closure: preserve trusted per-turn context through the execution
adapter and test direct/proxied parity, permissions, recursion suppression,
credential overrides, and cancellation. Do not take runtime flags from model
arguments.

### P1: Applied approvals can revert to pending when publication fails

The approval route applies the action before calling `setActionStatus`.
That function makes status and notification publication transactional, but
signal admission can throw when the target's backlog is full. The status
update rolls back even though the action was already applied. The proposal
remains pending and can be applied again.

Sources: [apply before bookkeeping](../../app/api/v1/pending-actions/%5Bid%5D/approve/route.ts#L34),
[status/publication transaction](../../lib/stores/pending-actions.ts#L79), and
[backlog rejection](../../lib/stores/system-signals.ts#L69).

Reproduced: fill the isolated outbox to its per-thread limit, apply a synthetic
configuration change, and record approval. Recording throws, the proposal is
still pending, and the applied change remains.

Required closure: reserve notification capacity before action execution or
use a non-lossy outbox path for terminal outcomes. Outcome bookkeeping must
never falsely make an already-applied action retryable. Test rollback and
external-effect uncertainty separately.

### P1: Persisted results have no live repair path after event publication fails

Durable result persistence and operation/event completion are separate writes.
`settleSignal` catches publication errors and only logs them. The result can
be done while its operation remains accepted and no delivery exists. Boot
reconciliation can repair some cases, but the current scheduler does not
repair them while the same process keeps running.

Sources: [result persistence](../../lib/tools/support/wallclock.ts#L328) and
[caught publication failure](../../lib/tools/support/wallclock.ts#L291).

Reproduced: reject event insertion using an isolated SQLite trigger. The
encrypted result is done, the operation remains accepted, and the owning
thread is absent from the due-wake query.

Required closure: atomic outcome/outbox persistence or a bounded durable
publication retry/repair mechanism. Test the crash and failure boundaries
between result storage, event publication, and dispatch.

### P1: Timeout persistence failure skips outcome publication

The timeout callback sets `settled=true` and calls `failAsyncCall` without a
guard. If encrypted error persistence throws, the callback exits before
publishing the timeout signal. Late completion is subsequently discarded.

Source: [timeout callback](../../lib/tools/support/wallclock.ts#L306).

Reproduced: inject a durable-result write failure when the deadline fires.
The timer throws, the operation remains accepted, and no outcome event exists.

Required closure: make timeout settlement failure-safe, preserve an unknown
outcome, and provide durable repair. Test full storage, locked encryption,
serialization errors, late completion, and failures during error handling.

### P2: Transcript persistence failure strands delivery leases

The stream wrapper treats provider `done` as stream success and does not
release its lease. If the caller then fails to persist the transcript, the
receipt stays leased. Wake failure deferral only handles ready rows, so this
path waits for the 30-minute lease timeout rather than normal retry backoff.

Sources: [stream success/release](../../lib/agents/run-thread.ts#L903),
[caller persistence](../../lib/agents/agent-turn.ts#L194), and
[ready-only failure deferral](../../lib/stores/system-signals.ts#L247).

Reproduced: a real agent turn with a synthetic provider response and a SQLite
trigger rejecting assistant insertion. The turn fails and the delivery is
still leased immediately afterward.

Required closure: one owner for the lease through stream collection and
transcript commit, with explicit release on persistence failure. Test empty
responses, NO_REPLY, errors, aborts, expired tokens, and each persistence caller.

### P2: Native delegate background jobs are outside the durable contract

Claude's `background=true` launches a native job and completes it through its
separate jobs store. That callback is not a system-signal producer. Wrapping
the launch itself in `async_run` would notify that launch returned, not that
the delegated task completed. Native Codex jobs also require an explicit
adapter audit rather than assuming the generic wrapper covers them.

Source: [Claude native background branch](../../lib/tools/delegation/claude-delegate.ts#L584).

Evidence: source-path inspection; no real CLI execution was attempted.

Required closure: map native job identity, terminal callback, durable result,
owner, cancel state, and interruption state into the shared contract. Test
both native `background=true` and generic `async_run=true` paths.

## Coverage Matrix

| Boundary | Audit evidence | Status |
| --- | --- | --- |
| Small result encryption and owner-key retrieval | Existing store tests; real owner/peer retrieval in probes | Covered for small envelopes |
| Oversized storage and reference access | Real wrapper, SQLite, file spill, and result tool | Defect reproduced |
| Direct completion permission denial | Existing final-binding and restart-guard regressions | Locally covered |
| Proxy target permission denial | Existing explicit proxy denial regression | Locally covered |
| Proxy runtime-context propagation | Real proxy, executor, wrapper, and journal | Defect reproduced |
| Result-to-event failure | SQLite failure injection | Defect reproduced |
| Timeout-to-event failure | Fake deadline plus injected storage failure | Defect reproduced |
| Transcript-to-ack failure | Real agent runner and SQLite rejection | Defect reproduced |
| Approval-to-outbox admission | Saturated isolated outbox and applied state | Defect reproduced |
| Locked boot and restart reconciliation | Existing mocked lifecycle and real store tests | Component coverage only |
| Wake-to-UI refresh | Existing producer/bus/hook tests | Component coverage only |
| Native delegate completion | Source inspection | Adapter coverage missing |
| Provider SDK retries versus admission limiter | Documented limiter limitation | Not quota-compliant per wire attempt |
| Process kill, supervised restart, load, and live model | Not run by this audit | Operational coverage missing |

## Method and Confidence

Six temporary observation probes exercised actual SQLite, encryption, file
storage, wallclock wrapping, proxy execution, result retrieval, and agent
persistence. The provider stream and dispatch scheduling were replaced only
to avoid network calls and unsolicited work. All six observations reproduced
their named defects. Passing observation assertions means the defect was
confirmed, not that the system satisfied its acceptance invariant.

The temporary probes were removed rather than adding tests that permanently
assert broken behavior. Each correction should convert its reproduction into
a regression test asserting the desired outcome, in the existing appropriate
test surface. No production source repairs were made as part of this audit.

## Release Gate

Do not describe the backbone as operationally reliable or recommend deploying
it based on the aggregate unit count alone. Close the P1 findings as a coherent
boundary-hardening change, fix lease ownership, and add a single full-flow
contract suite before a real supervised restart/load trial. The restart-loop
correction in the local baseline is not evidence that these remaining
integration defects are fixed.