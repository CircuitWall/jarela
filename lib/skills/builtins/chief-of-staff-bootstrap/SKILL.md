---
name: chief-of-staff-bootstrap
description: "Use when: bootstrapping the chief-of-staff setup in any repository or agent system — engine, clock, CoS skill, instruction, and fixtures adapted to the host."
---

# Chief of Staff Bootstrap

Build the chief-of-staff setup in a target repository with **any language and
any agent system**. The result is the same properties as the Jarela reference,
implemented with the host's primitives: a deterministic engine, a clock, a
durable register, a loadable CoS skill, an autonomy matrix, and
self-adaptation. Do not copy Jarela's files, names, tools, or policies; adapt
the concepts.

## Input

The target repository and host agent system, the capabilities observed in
Phase 0, and the user's answers to the fit question and the question map. A
setup begun without a recorded fit decision is not ready to write files.

## Output

A recorded fit decision — including a documented "no fit" that stops the
setup — and, when the user approves, the installed CoS components (doctrine,
engine, optional clock and register, CoS skill, instruction, and bootstrap
record) on the host's existing surfaces. No file is written before the Phase 1
approval.

## Validation

Run the host's own checks rather than inventing a parallel suite: the engine
fixtures in the host's test framework, the host's lint/typecheck/test commands,
a clock dry run, and one smoke task that loads the CoS skill without this
bootstrap skill and reaches the engine, verdict, and escalation rule. Record
the exact command and observed result for each item. A denied capability, a
cancellation, a missing fixture, or missing evidence is a blocker or an
explicitly recorded non-result, never a pass.

## Host capability check (do this first)

The host must provide, directly or through an equivalent:

- file read/write, to add the engine, skill, doctrine, and tests;
- command execution, to run the engine, fixtures, and a clock dry run;
- a test runner, or a documented way to verify the fixtures;
- git or the host's VCS, for the topic branch and review;
- a skill or instruction surface the host's agent loads (a skills directory,
  `AGENTS.md`, `CLAUDE.md`, or always-on instructions).

If a capability is missing, use the host's equivalent. If no equivalent
exists, stop and report it — a chat-only host cannot carry the deterministic
setup, and a prompt-only imitation is not the same thing.

## Interactive setup protocol

Analyze first, then ask. This is a guided install, not a scaffolding script.

- Ask **one decision at a time**, with the recommended option first, the
  tradeoffs, and what the choice changes. Wait for the answer; never assume
  it.
- **Write nothing** — no engine, clock, skill, instruction, dependency, or
  CI change — before the user approves the plan in Phase 1.
- At every phase gate, present: what you found, the recommendation, the
  options, and the exact files/commands that would change. Ask to continue.
- If the user declines or picks a lighter option, record that outcome and
  stop or narrow the build. Declining is a successful result.
- Use the host's choice mechanism when it has one (Jarela:
  `propose_config_change` with `kind: ask_choice`; other hosts: their
  question/approval surface). Otherwise ask in chat. Do not invent a panel.
- Record every answer in the bootstrap record, with the evidence for the
  recommendation.

## Phase 0.5 — Fit assessment (the first question)

Measure the repository before proposing any setup:

- **Size:** tracked files and source files (`git ls-files | wc -l`), module
  count, languages.
- **Activity:** commits and distinct authors in the last 90 days
  (`git log --since="90 days ago" --oneline | wc -l`,
  `git shortlog -sne --since="90 days ago"`).
- **Verification:** test, lint, typecheck, and CI commands that actually
  exist.
- **Automation:** scheduled jobs, watchers, bots, releases, deploy workflows.
- **Delegation:** subagents, coding CLIs, background jobs, and how many are
  open.
- **Open loops and risk:** open PRs/issues (if `gh` or the host provides
  them), protected branches, release/deploy steps, secrets.

Classify and present the **first question**:

| Fit | Profile | Recommendation |
| --- | --- | --- |
| **No fit** | small repo, low activity, weak verification, little or no delegation | Do not set up CoS; use direct work and the existing checks |
| **Light** | moderate size/activity, occasional delegated work, some verification | Engine + CoS skill (brief, review, adaptation); no clock or register |
| **Full** | active repo, recurring upkeep, frequent delegation, strong verification | All eight components: engine, clock, register, CoS skill, adaptation, record, guardrails, doctrine |

Use these as defaults, not gates. If the profile falls between two levels,
prefer the lighter option and explain why; a heavier setup can be added later
once a tick or a delegated task proves it is needed.

The question: *"Repo profile: <facts>. CoS fit: <no/light/full> because
<reasons>. Recommendation: <option>. Do you want none, light, or full?"*
Put the recommendation first and explain the cost of each option.

- **No fit:** record the analysis and stop. Do not scaffold. This is a
  successful outcome.
- **Light:** build the engine and the CoS skill only; skip the clock,
  register, and recurring cadence.
- **Full:** continue through all phases.
- If the user chooses a heavier option than recommended, proceed but state
  the added maintenance cost and get explicit approval.

## Question map

Ask these one at a time, after the fit decision and with a recommendation
derived from Phase 0:

| # | Decision | Recommended default |
| --- | --- | --- |
| 1 | Fit: none / light / full? | The matrix result above |
| 2 | Which signal classes? | Only deterministic signals with real evidence (stale guides, broken references, dependency advisories, milestone slippage, failed scheduled jobs, unverified delegated work) |
| 3 | Cadence: scheduled or manual, how often, what time? | Manual first; weekly schedule once a tick has produced a real decision or no-change |
| 4 | Register: checked-in report or issue queue? | Checked-in report for a code repo; issue queue for a team workflow |
| 5 | Agent surface: where does the CoS skill load? | The host's existing skill/instruction surface; do not add a second one |
| 6 | Delegation: which mechanism and permission mode? | The host's existing delegation, least privilege |
| 7 | Autonomy: confirm the adapt/escalate/never matrix | Escalate anything irreversible or permission-widening |
| 8 | Implementation: language, runtime, test command? | The repo's existing stack; no new runtime |
| 9 | May I add a dependency or CI job? | No new dependency or runtime; reuse the existing CI |
| 10 | Handover: open a topic branch and PR? | Yes, with the evidence; never merge or push the default branch |

## What "similar setup" means

1. **Doctrine** — why event-bound checks cannot see untouched work; a table
   of checks, triggers, and cadence; the three outcomes (decision / doctrine
   change / recorded no-change); the unattended-safe vs escalate matrix; the
   register decay policy.
2. **Deterministic engine** — collection, ranking, verdicts, and adaptation
   as code; a stable JSON contract; fixtures for clean, decision, escalation,
   and no-change. No model or network in the default path.
3. **Clock** — a scheduled job or a documented manual cadence that runs the
   engine, writes a durable report, records no-change when byte-identical,
   and opens a PR or issue only for a real decision. It never merges, pushes
   the default branch, approves, or makes paid calls.
4. **Loadable CoS skill** — the procedure the host's agent follows when asked
   to coordinate delegated work: brief, dispatch, supervise, verify, adapt,
   escalate, record. Adapted to the host's delegation mechanism, and
   discoverable without the bootstrap skill.
5. **Durable register** — the report or issue queue that survives a tick;
   history belongs to git/issues, not an append-only list.
6. **Self-adaptation** — every issue yields a classification and a next
   action; recurring or P0 lessons are persisted where writable; policy is
   never widened automatically.
7. **Bootstrap record** — a checklist with observed evidence per component,
   in the host's tracker or a durable note.
8. **Guardrails** — no new runtime, dependency, permission, or CI gate
   without approval; no merge, default-branch push, release, or secret.

## Concept mapping

| Concept | Jarela reference (when available) | Host choice |
| --- | --- | --- |
| Doctrine | `docs/CHIEF_OF_STAFF.md`, `docs/CADENCE.md` | The host's docs, adapted to its terms |
| Engine | `scripts/cadence-audit.mjs`; `delegation_brief` / `delegation_review` / `delegation_cadence` | A native module in the host's language and test framework |
| Clock | `.github/workflows/cadence-review.yml` | GitHub Actions, GitLab schedules, Jenkins, cron, or a documented manual trigger |
| CoS skill | `lib/skills/builtins/chief-of-staff/SKILL.md` | The host's skill or instruction surface |
| Register | `docs/CADENCE_REPORT.md`, `workflow_progress` | A checked-in report, an issue queue, or the host's tracker |
| Delegation | `claude_delegate` / `codex_delegate` / `copilot_delegate` / `delegate_to_agent` | The host's subagents, coding CLIs, or human handoff |
| Fixtures | Vitest suites in `lib/tools/delegation/` | The host's test runner, with the same cases |

## Phase 0 — Discover

Record, with file evidence: the resolved root and whether it is a VCS work
tree; language, runtime, package manager, formatter, linter, and test command;
the CI provider, its schedule support, and its token model; which checks are
event-bound and which already run on a clock; existing instruction surfaces;
contribution rules; delegation surfaces and their permission model; any
existing report, register, or tracker; secrets and online calls.

Output: a discovery note listing what exists, what is missing, and which
components can be built without a new process or dependency.

## Phase 1 — Design and consent

Turn the fit decision and the question-map answers into a written plan, then
ask for approval before writing anything.

- Choose deterministic, meaningful signal classes: stale or idle guides,
  broken references, dependency advisories (opt-in), milestone slippage,
  failed scheduled jobs, finished-but-unverified delegated work.
- Choose the clock and all three outcomes. A component that cannot produce a
  decision, a doctrine change, or a recorded no-change is not scheduled.
  In **light** mode, skip the clock and register.
- Choose the register location, the CoS skill surface, and the delegation
  mechanism.
- Write a one-page doctrine adapted to the repo.
- Present the plan: components, files, commands, cadence, register, agent
  surface, delegation, autonomy matrix, and the answers to questions 2-10.
  Ask for explicit approval.
- A new runtime, dependency, CI job, or permission needs the user's approval.
  Never weaken an existing gate to make the setup fit.

## Phase 2 — Engine

- Freeze the JSON contract first: decisions with stable ids, severity, owner,
  action, evidence; a `no_change` result; skipped sources with a reason; an
  adaptation field. Define the brief/observation/verdict shapes the CoS skill
  will call.
- Write fixtures for clean/no-change, an actionable decision, an escalation,
  a blocked/permission case, and an adaptation case. The fixtures are the
  conformance oracle.
- Implement natively in the host's language and module layout, using the
  standard library and existing dependencies. Bound every input and output;
  keep detection offline and deterministic; make failures and skips explicit.
- Port the fixtures into the host's test framework and run them.

## Phase 3 — Clock

- Use the host's scheduler. Pin the runtime, use the least-privilege token,
  and fetch the history the checks need.
- Run the engine; write the durable report; upload the machine result as an
  artifact when supported.
- If the report is byte-identical, post a "no change recorded" summary and do
  nothing else — that is a result, not a silent green tick.
- Otherwise open or update a PR (or an issue) against the default branch;
  never merge, push the default branch, approve a review, or spend model
  tokens. Keep the bot branch single-writer.
- Dry-run the clock manually and inspect the report diff and run summary.

## Phase 4 — Install the CoS skill

The bootstrap is complete only when the host's agent can load a CoS skill and
use it without the bootstrap skill. Author it from this template, then adapt
the names and commands:

```text
# Chief of Staff
Use when: work is delegated to another agent or CLI, multiple delegations are
open, a scheduled review is due, or an irreversible action needs an
evidence-based decision. Do not use for direct, watched edits.

## The loop
Brief → dispatch → supervise → verify evidence → adapt → escalate → record.

## Engine
<exact command with the contract path; input/output shapes>.
The fixtures are the conformance oracle.

## Delegation
<the host's mechanism and permission mode>; record the id.

## Autonomy
Adapt: revise a brief, retry a transient, stop a stall, re-verify.
Escalate: permissions, scope, target, cancel, irreversible.
Never: merge, default-branch push, approve, release, or bypass a gate.

## Evidence
Exact command and exit code for command acceptance; a recorded observation
for manual acceptance. Missing evidence is retry, never accept.

## Cadence
<clock or manual trigger>; decisions, doctrine changes, or a recorded
no-change.

## Non-goals
Not an auto-merger, auto-publisher, or approval bypass.
```

Adaptation rules:

- When the reference `chief-of-staff` skill is available, copy it and adapt
  the names and commands instead of re-authoring from the outline. The
  outline is the fallback for a host that cannot read the reference.
- Replace Jarela tool names with the host's engine command, ledger, and
  delegation mechanism. Keep the loop, evidence rule, autonomy matrix, and
  the activation gate — do not broaden the trigger to every task.
- Put the skill on the host's canonical surface (for example
  `.claude/skills/`, `.github/skills/`, `.agents/skills/`, or the documented
  instruction file). If the host has no skill system, embed the same content
  in the always-on instruction and say so.
- **Verify the skill loads.** Use the host's skill list or discovery
  mechanism if it has one. If it does not, ask the agent to perform one
  smoke task: state the engine command, the verdict path, and the escalation
  rule without reading the bootstrap. Record what happened.
- Keep one CoS skill and one instruction surface; do not duplicate.
- If the host uses module guides, follow that host's format (frontmatter with
  `Use when:`, tools, reasoning effort; scope; anti-patterns; file map;
  testing; review checks) and run its checker.
- Verify every named tool, path, and command exists and passes. Do not
  advertise a capability the implementation does not have.

## Phase 5 — Verify, adapt, hand over

- Run the engine against the real repository; confirm the findings are real;
  tune thresholds only with evidence.
- Exercise self-adaptation: a finding must produce a revised action or a user
  decision; a recurring or P0 lesson must have a persistence target.
- Run the host's full gates: fixtures, tests, lint, typecheck if any, and a
  clock dry run. Record commands and results.
- **Load the CoS skill and run one smoke task** through the host's agent: it
  must reach the engine, produce a verdict, and stop or escalate correctly.
  This is the proof that the setup is usable when the skill is loaded; it is
  not a live delegation success.
- Follow the host's contribution rules: topic branch and PR with the
  evidence. Do not merge, push the default branch, or publish.
- Record the bootstrap checklist in the host's tracker with one evidence line
  per component and every gap called out.

## Definition of done

- [ ] Fit decision is recorded, including a documented "no fit" when the
      recommendation was to stop.
- [ ] The user approved the plan, and the question-map answers are recorded.
- [ ] Doctrine exists and names the three outcomes and the autonomy matrix.
- [ ] Engine implements the frozen contract and its fixtures pass in the
      host's test framework.
- [ ] Clock runs, writes the report, records no-change, and never merges or
      pushes the default branch.
- [ ] CoS skill is installed on the canonical surface, adapted to the host's
      delegation mechanism, and loadable without the bootstrap skill.
- [ ] Agent instruction (module guide or equivalent) names the engine
      command and the escalation rule; every path/command verifies.
- [ ] Durable register exists and is documented.
- [ ] Self-adaptation is exercised and recurring lessons have a persistence
      target.
- [ ] Bootstrap record has evidence per component.
- [ ] No gate weakened, no permission widened, no new runtime/dependency
      without approval, no secrets.

## Stop conditions

- The host lacks file/shell/test capability or a skill/instruction surface,
  and no equivalent exists.
- No deterministic signal source exists, or the only available check needs a
  model call by default.
- The host has no scheduler and no agreed manual cadence.
- A new runtime, dependency, CI job, or permission is required without
  approval.
- The safety/permission model blocks the work, or existing instructions
  conflict with the implementation in a way the user has not approved.
- The work tree is on the default branch and the setup needs to write.

Report the blocker with exact evidence; do not route around it.

## Boundaries

- Do not copy Jarela-specific names, files, tools, or policies; adapt the
  concepts and record the mapping.
- Do not embed the engine in the skill; the code lives in the host
  repository. The CoS skill references the engine by its documented command.
- No merge, default-branch push, release, review approval, or permission
  widening.
- No paid model call in the engine or the clock.
- A bootstrap is evidence for the setup's contract, not proof that a live
  delegation or a future tick will succeed.
