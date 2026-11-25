# ADR-0127: Follow background work instead of abandoning it

Status: **Accepted**

Date: 2026-11-25

Related: [ADR-0073](./0073-live-tool-progress-and-idle-wallclock.md) (live tool
progress and the idle wall-clock budget),
[ADR-0079](./0079-tool-result-references-and-spill-lifecycle.md) (result
references and spill lifecycle),
[ADR-0091](./0091-durable-agent-system-signals.md) (durable agent system
signals), [ADR-0032](./0032-script-backed-scheduled-tasks.md) (scheduled
tasks).

## Context

`async_run: true` already lets any tool call run in the background: the call
returns an `async_<hex>` key, its outcome is encrypted in SQLite for seven
days, and a completed thread-owned call wakes its agent (ADR-0091). Two gaps
remained:

1. **A single wall-clock budget was the only way out of a slow call.** When
   `deadline_ms` fired, the wrapper returned `error_code: tool_timeout` and
   abandoned the promise. The work usually kept running with no receipt, so the
   agent was told "do not retry" about something it could neither inspect nor
   wait for. Models cannot predict how long a build, install or test suite
   takes, so picking `async_run` up front is a guess.
2. **A pending call reported only "pending".** `tool_result_get` could wait for
   a result or report that none existed yet; it could not say what the call had
   produced. The only tail-like surface was `terminal_read`, which dumps a whole
   buffer with no cursor, no exit code and no owner check, and none of the
   `terminal_*` tools are bound to a default agent.

An agent that cannot see intermediate output has no safe way to answer a
follow-up question mid-task: it either blocks the turn or polls blindly.

## Decision

Extend the existing asynchronous result path. Do not add a second job engine,
a second registry, or a second start mechanism.

### Promotion instead of abandonment

When a call outlives its budget and an owning thread exists, the wrapper moves
the call to the background rather than discarding it:

- The in-flight promise keeps running. Its settlement runs the same
  `postProcessToolResult` path, completes the same async record, and publishes
  the same durable completion signal as an `async_run: true` call.
- The turn receives `{ ok: true, backgrounded: true, key, ... }` plus an
  explicit "do not repeat it" instruction, so the agent follows work it would
  otherwise have lost.
- Output reported before the deadline is replayed into the record's progress
  window, so the part that happened on the clock is not lost.
- Without an owning thread there is nobody to wake and no durable receipt, so
  the previous structured timeout result is returned unchanged. This keeps the
  behaviour of direct, non-agent tool invocation.
- If intent persistence fails (for example the operation backlog is full), the
  structured timeout result is returned instead. A timer callback that throws
  must not leave the turn waiting on a promise nothing will resolve.

Intent ordering (ADR-0091: "persist intent before invoking"). Every other
asynchronous producer — `runAsync`, `claude_delegate`, `codex_delegate`,
`copilot_delegate` — writes its `runtime_operations` row before starting
external work. Promotion cannot: the foreground path deliberately keeps no
per-call operation row, because creating one for every read would exhaust the
operation and delivery backlog limits. The promoted row therefore records the
truth instead of a comfortable fiction: `promoted: true`, `started_at` (the
real invocation start) and `deadline_ms` in the payload. A crash between
invocation start and promotion leaves no operation row; the unanswered tool
call in the transcript is the only trace, and nothing replays it. A crash after
promotion is handled by the existing paths: restart reconciliation marks an
unfinished accepted operation `outcome_unknown` and
`interruptBackgroundResults` marks the pending result as interrupted.

`async_run: true` remains the way to choose the background up front; promotion
is the fallback for the case the model cannot predict.

### Progress on the same record

`AsyncResultRecord` gains `progress`, `progress_bytes`, `last_output_at`,
`exit_code` and `log_path`. Progress is ephemeral and lives beside the durable
outcome, not in the database:

- A bounded in-memory window (`PROGRESS_WINDOW_BYTES`, 64 KiB) keeps the tail.
  A cursor older than the window reports `dropped_bytes` and resumes at the
  oldest byte still held, so a slow reader never silently loses its place.
- The full stream is appended to `$JARELA_DB_DIR/background-tasks/<key>.log`,
  capped at `PROGRESS_LOG_MAX_BYTES` (8 MiB), so history can be searched with
  `file_grep` and read with `file_read` instead of through an ever-expanding
  tool response. The file is deleted when the result is consumed, and idle
  logs older than `PROGRESS_LOG_RETENTION_MS` (24 h) are pruned whenever a new
  one is created — one capped file per background call must not accumulate
  forever.
- The record's exit code is derived from the tool's own `exit_code` field at
  settlement, in one place (`completeAsyncCall`), not by each caller.

Losing the window on restart costs progress only. The outcome keeps its
ADR-0091 guarantees.

### One read surface

`tool_result_get` grows a `cursor` parameter:

- While the call is pending it returns the `progress` page. With a `cursor` it
  returns only what changed, and `wait_ms` returns as soon as new output
  arrives instead of waiting for completion.
- Without a `cursor`, `wait_ms` keeps its documented behaviour of waiting for
  the call to finish, so existing callers are unaffected.
- `tool_result_list` reports `progress_bytes`, `last_output_at` and `exit_code`
  so an agent can distinguish a call that is producing output from one that is
  stalled.

### Output reaches the record

Bulk output is distinguished from progress:

- `reportToolOutput` (stdout, stderr, file deltas) is forwarded to the
  transcript and to the record but does **not** reset the idle budget.
  `reportToolProgress` keeps resetting it (ADR-0073). Without this split, a
  chatty long-running build could extend its own deadline indefinitely.
- `TerminalSession` gains an output hook (constructor and per-exec listener) so
  `local_exec` and `terminal_exec` stream what the process prints instead of
  producing output only at the end.

### Waiting without a turn

`schedule_wakeup` arms a one-shot scheduled task (`in_ms` or `at_iso`) whose
firing prompt is the message the agent pre-configured. It is the relative-time
form of `schedule_task`: the same store, the same scheduler, the same
cancellation — no new persistence and no new process. It exists so the agent
answers "check back on this in ten minutes" by ending the turn instead of
holding it open or polling.

## Consequences

- A slow call no longer loses its work. It can also not be cancelled: an
  arbitrary tool call has no abort handle, so cancellation stays absent rather
  than pretending to be cooperative. `local_exec` work is bounded by its own
  `timeout_ms`.
- Promotion can produce a wake-up turn after the original turn ended. It uses
  the existing read-only completion overlay from ADR-0091; it grants no new
  permission and never repeats the promoted call.
- One new data-directory subfolder (`background-tasks/`) holds capped,
  non-secret logs. It is created lazily, and a record without it still works.
- The progress window is intentionally not durable. After a restart the agent
  can read the outcome but not the intermediate output; the prompt tells it
  that a `pending` call's evidence is bounded.
- `local_exec` and `terminal_exec` now stream output to the transcript. This is
  additive: the returned result is unchanged, and `stream: false` still
  silences the transcript while leaving the record populated.

## Verification

- `lib/tools/support/async-results.test.ts`: output capture, cursor paging,
  window overflow accounting, progress on a pending record, `wait_ms` with and
  without a cursor, progress for finished calls only when a cursor is supplied,
  cursor schema rejection, `consume` removing the progress and its log,
  per-thread isolation of progress, `tool_result_list` progress/exit-code
  reporting, promotion receipt and its late settlement, the promoted operation
  payload (`promoted`, `started_at`, `deadline_ms`, `wake_eligible`),
  concurrent promotions with distinct records, the unchanged no-thread timeout,
  and the log lifecycle (creation, consume, idle pruning).
- `lib/tools/support/wallclock.test.ts`: bulk output does not extend the idle
  budget while progress does, output still reaches the transcript, and the
  fallback receipt when promotion cannot persist intent.
- `lib/tools/general/exec.test.ts`: a real process streams ticks into the
  record, a persistent `terminal_exec` session streams through its listener, a
  blocking `local_exec` promoted at its deadline keeps both its output and its
  exit code, and a follower reads a promoted call through `tool_result_get`.
- `lib/tools/general/schedule.test.ts`: the wakeup is a one-shot task whose
  prompt is the supplied message, with no agent context, ambiguous time, a
  silent flag, an absolute time, or a time in the past.
- `lib/tools/runtime/external-wallclock.test.ts`: promotion through the
  `invoke_tool` proxy.
- `npm run test:prompts` after the Tool usage SOP addition.
- `npm run check:impact` for ripple analysis.

Not verified: model behaviour — that an agent follows instead of repeating, and
timely use of `schedule_wakeup` — needs live evaluation, not unit tests.
