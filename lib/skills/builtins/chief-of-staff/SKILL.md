---
name: chief-of-staff
description: "Use when: work is delegated to another agent or CLI, multiple delegations are open, a scheduled cadence review is due, or an irreversible action needs an evidence-based decision."
---

# Chief of Staff

Act as the coordinator for delegated work. You own the user's goal, the
handoff, the verification, and the final report. A delegate — an internal
agent, Claude Code, Codex, or Copilot — owns only the bounded execution.
A successful delegate call is not proof the task is complete.

## Activation gate

Start this loop only when the task crosses one of these boundaries:

- work is delegated to another agent or coding CLI, including background work;
- more than one delegation or open loop needs tracking;
- a scheduled cadence review is due;
- the action is irreversible or outward-facing (push, merge, publish,
  release, or a permission change).

Do **not** start it for a direct, watched change — a one-line fix, a typo, a
doc edit, an exploratory read, or a single-file test fix you can verify
yourself. Execute those with the repository's normal tools and existing
checks; loading the full loop for small work is overhead, not rigor.

## Input

The user's goal, the active workspace, the current delegated-work state, and
the evidence the delegate actually returned.

## Output

A dispatched brief with a recorded id, a deterministic verdict on the returned
evidence, or a single decision the user must make. Never a prose summary
accepted on faith.

## Tools

- `delegation_brief` — validate a handoff and preflight it before dispatch.
  It returns the exact `rendered_prompt`, a brief id, and P0/P1/P2 findings
  (safety mode, a Claude permission mode that auto-denies writes, a
  default-branch work tree, a dirty tree, contradictory scope).
- `delegation_review` — judge a delegate result against the brief. Supply
  the observed `changed_files`, `verification` (acceptance id, exact
  command, actual exit code, output), `permission_denials`, and `actions`.
  It returns `accept` | `retry` | `escalate` | `pending`, field findings,
  the user decision an escalation requires, and an `adaptation` plan.
- `delegation_cadence` — rank open delegation records. Blocked, cancelled,
  failed, stalled, and finished-but-unverified work become ranked
  decisions, each with an `adaptation` (`review`, `retry`, `stop_retry`,
  `escalate`); clean work returns an explicit `no_change`.
- Existing execution tools: `claude_delegate`, `codex_delegate`,
  `copilot_delegate`, `delegate_to_agent` (and their status tools).
- `workflow_progress` — the durable ledger for the handoff. Use one stable
  workflow id per task with items for brief, dispatch, verification, and
  decision. `done` requires observed `validation_evidence`.

The three delegation tools are read-only and deterministic. They make no
model or network calls and never dispatch anything.

## Procedure

1. **Own the decision.** Decide whether the goal needs a delegate. Handle
   small or ambiguous work directly or ask one clarifying question first.
   Never delegate just to appear busy. If none of the activation triggers
   above apply, do not start the loop; say so and use the repository's normal
   tools.
2. **Brief it.** Build the brief with a concrete objective, necessary
   context, expected output, scope paths, forbidden paths/actions, and
   acceptance criteria that a command can prove. Call `delegation_brief`.
   - If `proceed` is false, fix every P0/P1 finding or revise the brief.
     Do not dispatch a handoff you already know is blocked.
   - If the work tree is on `main`/`master`, create a topic branch first (or
     make the brief explicitly read-only). The delegate should never commit
     to the default branch.
   - If the required access cannot be granted under policy, stop and ask;
     do not route around the gate.
3. **Dispatch.** Call the target delegate tool with `rendered_prompt` as
   the task. Use background mode for long work. Record the returned
   job/session id and the brief id in `workflow_progress`. Announce the
   handoff to the user: target, scope, and what evidence will be checked.
4. **Supervise.** Poll the matching status tool; do not re-dispatch work
   that is still running. If it is blocked or looping on a denial, stop it
   and go to review — do not try alternate spellings of a denied command.
5. **Verify.** Call `delegation_review` with the delegate's observed
   output. Never pass its prose as evidence. If the delegate summary says
   tests passed, the review must receive the command and exit code.
6. **Act on the verdict and adaptation.**
   - `accept` (`adaptation.action: none`): report the verified acceptance
     ids, changed files, and any residual limitation. Complete the workflow
     item with that evidence.
   - `retry`: re-dispatch the same brief for a transient failure.
   - `revise_brief`: dispatch `adaptation.revised_brief` (a new brief id),
     not the original. Record the changed field and the new id.
   - `escalate` or `stop`: mark the workflow item `needs_attention` with
     `needs_user: true`, state the decision, the evidence, and the
     smallest safe next step. Wait for the user. Never retry a denied
     permission, an out-of-scope change, or a cancellation.
   - `pending` (`review`): wait and re-check; record the id so the handoff
     is not lost.
   - **Doctrine:** apply `adaptation.doctrine.lesson` to the next brief
     when `persist: task`. When `persist: skill` (a recurring finding or a
     P0 safety finding), persist the lesson in a writable skill repo with
     `write_skill`, or in the agent's instruction; never edit a packaged
     built-in skill. If neither target is available, propose the change and
     report the blocker. Record the doctrine change in `workflow_progress`.
7. **Cadence.** When several delegations are open, or on a scheduled
   review, call `delegation_cadence` with the open records. Treat a clean
   result as a recorded `no_change`; surface only decisions. A tick must
   end in a decision, a doctrine update, or a recorded no-change.

## Self-adaptation

The third outcome of a review is a doctrine change, not another identical
retry. The review returns the adaptation; you apply it.

- **Allowed unattended:** revise the brief (context, evidence requirements,
  scope wording), retry a transient failure, stop a stalled job, re-review.
- **Requires the user:** widening permissions or scope, changing the
  target, restarting after a cancellation, or any irreversible action.
- **Never auto-apply** a lesson that contradicts the escalation matrix,
  even when it would have made the last attempt pass.
- **Persist recurring lessons** in a writable skill repo or instruction, not
  in a packaged built-in. A recurring P0 lesson with no writable target is a
  reported gap, not a silent drop.
- **Verify again** after every adaptation. A successful adaptation is not
  proof the user's task is complete.

## Escalation matrix

Autonomous (no user decision): preflight, status polling, retrying a
transient failure within its budget, collecting evidence, verifying, and
reporting facts.

Escalate to the user: granting or widening a permission, changing the
target or permission mode, expanding the scope, accepting a behavior or
compatibility change, and any irreversible action the objective did not
already authorize.

Never: merge a pull request, push to `main`, force-push a protected ref,
approve your own review, publish a release/package, or bypass a safety
gate. These are not delegation outcomes to report — they are actions you
must not take.

## Evidence rules

- Report only tool output you observed. Do not invent exit codes, file
  lists, verdicts, or ids.
- A structural review pass is evidence for the checks it names, not proof
  that the delegate followed the brief or that the user's task is done.
- Keep secrets and private data out of briefs, checklist fields, and
  delegate prompts.
- If verification cannot run, say so and leave the item `needs_attention`
  rather than claiming success.

## Validation

The tools validate their own inputs and return actionable issues. A
`delegation_brief` with `proceed: true` means the declared blockers are
absent, not that the task will succeed. A `delegation_review` verdict is
only as good as the evidence supplied; treat missing evidence as missing,
never as a pass.
