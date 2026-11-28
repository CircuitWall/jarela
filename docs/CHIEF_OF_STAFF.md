# Chief of staff

Status: active. The setup is defined by the portable contract and its
fixtures. The Jarela reference implementation is
[lib/tools/delegation/delegation-contract.ts](../lib/tools/delegation/delegation-contract.ts)
(shapes and semantics),
[lib/tools/delegation/chief-of-staff.ts](../lib/tools/delegation/chief-of-staff.ts)
(typed tools), and the built-in
[chief-of-staff skill](../lib/skills/builtins/chief-of-staff/SKILL.md)
(agent procedure). The TypeScript files and Jarela tool names are one
implementation; another host may implement the same contract natively, and
the bootstrap skill does not require these files.

The chief-of-staff pattern makes one agent accountable for a goal while
specialists execute bounded parts of it. The coordinator owns the intent, the
brief, the verification, and the final report. A delegate — an internal agent,
Claude Code, Codex, or Copilot — owns only its bounded task. A successful
delegate call is not proof the user's task is complete.

## Implementation and portability

The contract is what travels: the JSON shapes, verdicts, finding codes, and
rules such as "missing evidence is retry, never accept." The fixtures are the
conformance oracle. This repo's TypeScript files are a reference
implementation, not a dependency of the framework. A Python module, a Go
command, or a host's native tools can implement the same contract; the shapes
and semantics must match, not the file names. Distribute the contract, the
fixtures, and the CoS skill — not the TypeScript. The bootstrap skill installs
the native implementation and a loadable CoS skill for the host.

## When to use it

Use the loop only when work crosses a boundary: it is delegated, several
delegations or open loops are active, a scheduled cadence review is due, or
the next action is irreversible or outward-facing. A direct, watched change —
a one-line fix, a typo, a doc edit, or a single-file test fix — is cheaper to
execute and verify with the repository's normal tools. The full loop is the
delegation equivalent of a Tier 2 contract, not a default wrapper around
every edit. The `chief-of-staff` skill carries the same activation gate in
its description and body; a host that installs it should preserve that gate.

## Why the pattern exists

Delegation fails in predictable ways that ordinary completion reporting misses:

- **The handoff stalls on a permission gate.** A headless delegate retries a
  denied command under several spellings and eventually gives up, leaving
  finished file work with no branch or commit.
- **The parent accepts prose.** "Done, tests pass" is not evidence. Without the
  command, exit code, and changed files, the parent cannot tell a real result
  from an optimistic one.
- **The work drifts outside its scope.** A delegate that edits an ADR, rewrites
  a lockfile, or pushes a branch has changed the decision the parent thought it
  delegated.
- **The handoff is forgotten.** Background jobs finish, fail, or sit stalled in
  a queue while the conversation moves on, because nothing reviews open work on
  a cadence.

The pattern makes each of those a deterministic checkpoint instead of a prose
judgement.

## The loop

Brief → dispatch → supervise → verify → adapt → record.

- **Brief:** objective, context, expected output, scope, forbidden actions,
  and acceptance criteria a command can prove; `delegation_brief` preflights
  it.
- **Dispatch:** call the host's delegate tool with the rendered prompt; record
  the id in the host's ledger.
- **Supervise:** poll status; never re-dispatch a running delegate; stop a
  denial loop.
- **Verify:** `delegation_review` checks observed evidence, not prose.
- **Adapt:** apply the review's `adaptation`; policy, scope, target, and
  irreversible decisions go to the user.
- **Record:** `delegation_cadence` ranks open work; clean work is an explicit
  `no_change`; recurring lessons are persisted.

## Operations

The contract defines three deterministic operations: **brief** (validate and
preflight), **review** (verdict plus adaptation), and **cadence** (ranked
decisions or an explicit no-change). Jarela exposes them as
`delegation_brief`, `delegation_review`, and `delegation_cadence`; the exact
input/output shapes and finding codes live in the tool schemas and
[delegation-contract.ts](../lib/tools/delegation/delegation-contract.ts).
Other hosts may expose the same operations as commands or functions; the
shapes and verdict semantics are what must match. All three are read-only and
make no model or network calls.

## Self-adaptation

Review returns an `adaptation`: `retry` (same brief), `revise_brief` (a
rewritten brief with the failing evidence), `stop`, or `escalate`, plus a
doctrine lesson scoped to the task or promoted to the coordinator's procedure
when the finding recurs or is P0. Cadence decisions carry the same action as
`review`, `retry`, `stop_retry`, or `escalate`. The adaptation boundary is the
escalation boundary: an adapted handoff is a proposal until its evidence
passes again.

## Escalation boundary

| Class | The coordinator may do it unattended | Limit |
| --- | --- | --- |
| Preflight a handoff and render its prompt | Yes | Read-only |
| Poll status, stop a stalled run, and retry a transient failure | Yes | Within the recorded retry budget |
| Collect changed files and acceptance evidence | Yes | Observe, do not alter |
| Accept a verified result | Yes | Only when every acceptance has evidence and scope is respected |
| Grant or widen a permission, or change the permission mode | **No** | The user decides |
| Expand the scope, change the target, or accept a behavior change | **No** | The user decides |
| Push, merge, publish, release, or rewrite published history | **No** | The objective and the user must both authorize it |
| Report a delegate's prose as verified work | **No** | Missing evidence stays missing |

## Cadence

Every review tick terminates in one of three outcomes:

1. **A decision for the user** — a ranked item with an owner and an action.
2. **A doctrine change** — the brief, scope, or target changes and the diff is
   visible in the workflow ledger.
3. **A recorded no-change** — `delegation_cadence` returns `no_change: true` and
   names why the open work is healthy.

A tick that reports green without checking the evidence is worse than no tick.
A failed review is not a fourth outcome; it is a failure and must surface as
one.

## Non-goals

- This is not an auto-merger, auto-publisher, or approval bypass.
- It does not replace the delegate tools' own permission checks, or authorize
  an action the user has not.
- It does not claim that a structural pass proves the delegate followed the
  brief or that the work is correct.
- It does not persist a new register; the workflow ledger remains
  `workflow_progress` and the delegate tools' own session/job stores.

## Bootstrapping and distribution

Use the `chief-of-staff-bootstrap` skill to reproduce this setup in any
repository and agent system. Its first question measures the repo — size,
activity, verification, automation, delegation, and risk — and recommends
**no fit**, **light**, or **full** before writing anything; a small,
low-activity repo is a valid "no fit" result. Subsequent decisions are asked
one at a time. It implements the contract natively, installs a loadable CoS
skill, and verifies the host's gates.

The shareable artifact is the **contract and its fixtures**, not a script
inside the skill: a Python module, a Go command, or a Node script can
implement the same JSON shapes. The skill carries the procedure; the code
lives in the repository. Packaged built-ins are never edited to persist a
lesson — use a writable skill repo or the agent's instruction.

## Validation

- Unit tests cover the preflight findings, every review verdict, scope and
  forbidden-action checks, and the cadence ranking.
- The tools return field issues for malformed briefs and observations rather
  than throwing.
- A `proceed: true` preflight means the declared blockers are absent, not that
  dispatch will succeed. A review verdict is only as strong as the evidence
  supplied.
- The fixtures are the conformance oracle for any native implementation: a
  port is accepted only when the same cases produce the same verdicts.
