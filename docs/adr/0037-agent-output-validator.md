---
status: "proposed"
date: 2026-05-30
deciders: example-user
---

# ADR-0037: Agent output validator (post-turn anti-fabrication guard)

## Context and Problem Statement

The harness ([ADR-0033](0033-configurable-harness.md)) embeds anti-fabrication
prose in the `plan_first` and `citation` sections: never invent IDs, never
report a tool result you didn't receive, never tag `(via foo)` for a tool
you didn't call. Despite that, observed agent transcripts still contain
hallucinated tool calls (e.g. references to a fictional `local_exec` tool),
fabricated "I patched / verified with grep" narratives in turns that called
zero tools, and post-hoc summary paragraphs describing actions that never
happened.

Prose rules in the system prompt are advisory: the model can ignore them
under synthesis pressure ("wrap up nicely") and the harness has no way to
know whether a rule was followed. The only signal we currently emit is
[`looksLikeStall`](../../lib/agents/run-thread.ts) — a regex check that
catches "one moment / let me check" turns with zero tool calls and either
appends a warning footer or auto-retries with a forceful nudge. That same
shape — inspect text + tool count post-stream, decide to warn/retry —
generalises to fabrication detection.

**Question:** how do we harden the existing prose anti-fabrication rules
with code-level enforcement without adding a heavyweight middleware layer?

## Decision Drivers

* Prose rules in `harness/presets.ts` are unenforceable from inside the
  prompt — only post-hoc inspection can verify them.
* The runtime already has a precedent (`stallRetryStream`) for exactly this
  pattern: hold the terminal `done` chunk, inspect text + tool count,
  decide to retry with a synthetic nudge. New behaviour should plug into
  the same place rather than introduce a parallel pipeline.
* Hallucination detection must be deterministic and fast (regex, not LLM)
  — running on every turn before the `done` chunk forwards to the client.
* Reject rate is itself the metric. Every retry/footer is a logged
  hallucination caught, giving us a feedback loop the prose rules don't.
* The user must be able to disable or audit the validator — same way
  every other harness section can be toggled in the UI.

## Considered Options

1. **Post-turn validator hooked into `stallRetryStream` (this ADR).**
   Add `validateAssistantOutput(text, toolCalls, allowedTools)` that
   returns `{ ok: true } | { ok: false, reason, kind }`. Extend the existing
   stream wrapper: if a turn ends with `!stalled` AND validator rejects,
   inject the same kind of synthetic-user nudge the stall path uses, with
   a reason-specific message. On the second attempt (no retry budget left),
   append a warning footer to the persisted message — mirrors how
   `persistAssistantMessage` already tags stalls.
2. **LLM-based judge as a second LLM call per turn.**
   After the assistant finishes, call a small model with the assistant
   text + tool log and ask "did the text claim things the tools don't
   support?" Higher recall (catches semantic fabrication, not just
   regex-matchable patterns) but doubles per-turn latency, doubles cost,
   and gives a non-deterministic gate.
3. **Tool-result enforcement only (drop text-claim checks).**
   The runtime already rejects `tool_use` blocks with unknown names. Push
   harder on the schema side and skip text inspection entirely. Cheap, but
   misses the dominant failure mode in observed transcripts: the model
   doesn't emit a fake `tool_use` block — it emits prose claiming a tool
   ran when no `tool_use` exists at all.
4. **Client-side warning banner only, no retry.**
   Detect fabrication in the client and surface a banner. Pure UX, no
   prompt-loop pressure. Catches the user but doesn't change agent
   behaviour, so the eval-driven feedback loop never improves the prompt.

## Decision Outcome

Chosen option: **1**, because:

* The integration point is already there (`stallRetryStream`). The new
  validator is a sibling check, not new infrastructure: same hold-the-done
  pattern, same synthetic-nudge retry, same warning-footer fallback.
* Deterministic regex-based checks give a stable gate the eval set can
  measure against, and the cost is one synchronous regex pass per turn —
  negligible next to the LLM stream.
* Failure modes the validator targets (action-claim without `tool_use`,
  `(via NAME)` for an unregistered or uncalled tool, "Summary" / "what I
  did" sections in zero-tool turns) are exactly what the observed
  transcripts show. Targeting them by shape is more direct than asking a
  judge model to opine.
* Falling back to a persisted warning footer (after retry budget is
  exhausted) gives the user a visible signal AND a metric we can chart —
  reject rate per agent, per harness, per model.

## Decision details

### Module layout

New module `lib/agents/output-validator/`:

* `types.ts` — `ValidationResult`, `Claim`, `Citation`, kinds enum.
* `claim-detector.ts` — regex set that matches first-person action verbs
  ("I patched", "I edited", "I wrote", "I ran", "I verified", "I created",
  "I deleted", "I updated", "I committed") + tense variants.
* `citation-parser.ts` — parser for `(via NAME)` / `(via NAME ARG)` /
  multi-source forms; returns `{ tool: string, raw: string }[]`.
* `validator.ts` — `validateAssistantOutput(text, toolCalls, allowedTools)`
  cross-checks claims and citations against `toolCalls`.
* `validator.test.ts` — table-driven cases. TDD.

### Validation kinds

Each rejection has a `kind`:

* `claim_without_tool` — action verb in text, zero matching `tool_use` in
  the same turn.
* `citation_unregistered_tool` — `(via foo)` where `foo` is not in the
  agent's `allowed_tools`.
* `citation_uncalled_tool` — `(via foo)` where `foo` is registered but
  wasn't called this turn.
* `summary_without_action` — "what I did" / "Summary of changes" /
  "I've completed" pattern in a zero-tool turn.

`reason` carries a human-readable explanation injected into the
synthetic-user nudge on retry.

### Wiring

Extend `stallRetryStream` in `run-thread.ts`. The current branch:

```ts
const stalled = !sawError && toolCount === 0 && looksLikeStall(textBuf);
if (!stalled) { yield doneChunk; return; }
// inject nudge, recurse
```

becomes:

```ts
const stalled = !sawError && toolCount === 0 && looksLikeStall(textBuf);
const fabricated = !sawError && !stalled
  ? validateAssistantOutput(textBuf, toolCalls, allowedTools)
  : { ok: true };
if (stalled) { /* existing path */ }
else if (!fabricated.ok) { /* mirror stall path: ↻ separator, nudge with reason, recurse */ }
else { yield doneChunk; return; }
```

`persistAssistantMessage` gets a third tag (alongside the stall warning):
`*⚠️ Output validator flagged: <reason>*` when the retry budget is
exhausted but the second attempt also fails.

### Tool-call surfacing into the stream wrapper

`stallRetryStream` currently increments a `toolCount` but doesn't track
tool *names*. The validator needs names to cross-check `(via foo)`
citations. Patch the loop to also push `chunk.data.tool_name` into a
`toolNames: string[]` when `chunk.type === "tool_call"`.

### Eval set

`scripts/live-test-hallucination.mjs` — a fixed set of synthetic
agent-output transcripts (text + tool log) fed directly to
`validateAssistantOutput`. Each scenario asserts the validator's verdict.
Runs in CI (no LLM cost). Acts as a regression harness: every real
hallucination observed in production is added to the set verbatim.

A second LLM-driven mode (`--llm`) is out of scope for this ADR; the
synthetic eval is sufficient to gate prompt and validator changes.

### Failure-mode coverage

| Failure mode (from observed transcripts) | Detected by                  |
| ---------------------------------------- | ---------------------------- |
| "I patched X" with no tool calls         | `claim_without_tool`         |
| "verified with grep via local_exec"      | `citation_unregistered_tool` |
| Long "Summary" recap, zero tool calls    | `summary_without_action`     |
| `(via memory_write)` but tool not called | `citation_uncalled_tool`     |

### Out of scope

* LLM-judge mode (option 2). Reachable later as an opt-in
  `validator_strictness` setting if the regex set proves too leaky.
* Detecting fabricated *content inside* a real tool result (e.g., the
  model paraphrases an ID it didn't see). The validator confirms the tool
  was called; verifying paraphrase fidelity needs structured comparison
  and is a separate ADR.
* Per-agent toggle for the validator. Default-on for everyone in v1; if
  the false-positive rate is high enough to need per-agent escape, that
  becomes a follow-up.

## Consequences

* Good — observable hallucinations now produce either an automatic retry
  (cheap) or a visible footer + log entry (auditable). Reject rate is a
  metric we didn't have.
* Good — sits in the same place as `stallRetryStream`. No new
  middleware concept, no new failure surface for the run pipeline.
* Good — the eval set turns prompt iteration from "read it again" into
  "run the eval, compare reject counts". Prompt edits gain a number.
* Bad — adds one synchronous regex pass per turn. Negligible vs LLM
  stream latency, but it is non-zero CPU.
* Bad — false positives are inevitable (a careful agent saying "I checked
  X" after an actual `file_stat` call but with phrasing that doesn't
  trigger a citation tag). Mitigated by: (a) only flagging when zero
  tools were called this turn, (b) treating `(via foo)` as proof a citation
  was attempted and only failing on missing/unregistered names, (c)
  retry-with-nudge as the first response, footer as the fallback.
* Neutral — the validator is in code, not in `harness/presets.ts`. That
  means custom harnesses can't disable it (yet). Acceptable for v1 since
  the prose rules it backs are themselves harness-section bodies that
  *can* be disabled — a user who turns off `citation` is signaling they
  don't want this gate, and a follow-up can read that as a feature flag.

## More Information

* Affected runtime path:
  [lib/agents/run-thread.ts](../../lib/agents/run-thread.ts)
  `stallRetryStream`, `persistAssistantMessage`.
* Sibling pattern: `looksLikeStall` / `STALL_PATTERNS` in the same file.
* Prose rules being hardened:
  [lib/agents/harness/presets.ts](../../lib/agents/harness/presets.ts)
  `PLAN_FIRST_BODY` (ANTI-FABRICATION) + `CITATION_BODY`.
* Related: [ADR-0033](0033-configurable-harness.md) (harness sections),
  [ADR-0036](0036-agent-driven-harness-edits.md) (agent-driven harness
  edits — explains why we don't bury the validator inside the harness
  data model).
