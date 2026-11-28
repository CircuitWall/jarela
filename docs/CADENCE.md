# Cadence review

Status: active. Implemented by [scripts/cadence-audit.mjs](../scripts/cadence-audit.mjs)
and [.github/workflows/cadence-review.yml](../.github/workflows/cadence-review.yml).
The durable artifact is `docs/CADENCE_REPORT.md`, written by the weekly run.

This document defines how Jarela verifies work that nobody has touched, what a
scheduled job may do without a human, and how review registers decay.

## The blind spot event-bound checks cannot see

Almost every check in this repository runs because something changed:

- the pre-commit hook runs on staged files,
- CI runs on a pull request or a push,
- lint runs on the tree in front of it,
- the prompt suite runs when prompt sources change.

That model is correct for changed code. It has an exact blind spot for unchanged
code. A module nobody has committed to in months has had **zero verification**
in those months: its `Agent.md` can silently contradict its implementation, an
accepted ADR can point at a file that moved, and a dependency can acquire a
high-severity advisory without any commit to trigger a scan. The absence of a
failure is not evidence of health; it is evidence that no check ran.

The clock-driven checks exist to make that absence visible. A weekly tick looks
at age, references, advisories, and milestone registers directly. It does not
wait for a commit, because the rot it is looking for is precisely the rot that
does not produce one.

## Every check and its trigger

`per-commit` means a local hook. `per-PR` means CI or a review tied to a pull
request. `clock` means a schedule. `manual` means a human explicitly dispatches
it. A check that exists only in a person's memory is not listed.

| Check | Trigger | Cadence |
| --- | --- | --- |
| `.githooks/pre-commit` (topic branch, module review, focused tests) | per-commit | every commit |
| `.githooks/commit-msg` (Conventional Commit subject) | per-commit | every commit |
| `npm run lint` (eslint, complexity, architecture patterns, agent docs, API docs, ADR registry, UI data access, integration manifests, Dockerfile workspaces, CI workflows) | per-PR and local | every app-touching PR |
| `ci.yml` conventions (PR title, commit subjects, module review) | per-PR, push to `main` | every PR and main push |
| `ci.yml` security scans (secrets, sensitive terms, dependency audit, version pins) | per-PR, push to `main` | every PR and main push; dependency audit only when manifests change |
| `ci.yml` build job (lint, typecheck, `next build`, route attestation, package checks) | per-PR | app-touching PRs |
| `ci.yml` unit coverage (80% line/function/branch/statement gate) | per-PR | app-touching PRs |
| `ci.yml` live integration + Playwright E2E + e2e coverage | per-PR | app-touching PRs |
| `ci.yml` prompt guardrails | per-PR | PRs that change prompt sources or the harness |
| `prompt-eval.yml` (LLM-as-judge provider drift) | clock, labelled PR, dispatch | weekly, Monday 06:00 UTC; costs provider tokens |
| `cadence-review.yml` (this doctrine) | clock, dispatch | weekly, Monday 06:00 UTC; no model calls |
| `nightly-release.yml` (version, changelog, adoption changeset, release PR) | clock, dispatch | daily, 03:00 UTC |
| `release.yml` (build and publish bundles, npm OIDC, Docker) | tag push, dispatch | per release tag |
| `release-docs.yml` (optional Copilot documentation proposal) | manual | opt-in only; spends AI credits |
| `docs-site.yml` (documentation site build) | push to `main`, dispatch | per main push touching docs |
| `pr-cache-cleanup.yml` | pull-request lifecycle | per PR |
| Copilot code review | per-PR | every PR; findings must be fixed or dismissed with a reason |
| `npm run check:impact -- --staged`, `npm run review:module -- --staged` | per-change, local; the pre-commit hook runs the module-review subset | every Tier 0/1 change |
| `npm run feature:contract` | manual | Tier 2 features (three or more modules, a public interface, persistence, a provider, or a new process) |
| `npm run packages:test`, `npm run test:package` | per-PR | workspace/package metadata changes |
| `npm run security:ci` | manual local aggregate | before release; CI runs its components per PR |
| `npm run docs:build` | manual; `docs-site.yml` runs on docs pushes to `main` | docs changes |
| `npm run test:live:full`, `test:eval`, `test:prompt-eval` | manual, explicit credentials | opt-in live or model evaluation |

The two weekly clocks answer different questions. Prompt evaluation asks whether
a real model still behaves correctly; cadence review asks whether an untouched
artifact is still true. Neither replaces the other, and neither is a substitute
for PR CI.

## Every tick has three outcomes

A scheduled tick must terminate in exactly one of these states:

1. **A decision for a human.** The tick opens or updates a reviewable artifact
   (for example the `cadence/report` PR) or records an item with an owner and a
   required action. The human decides; the tick does not.
2. **A doctrine change.** The tick updates the register it owns — a regenerated
   report, a corrected reference, a supersession note — and that change is
   visible in the diff. A doctrine change is still reviewed and merged by a
   human unless the matrix below explicitly delegates it.
3. **A recorded "no change".** The report contains a `No change recorded`
   signature for the clean classes, and the workflow step summary states that
   the report is byte-identical. This is a result, not an empty success.

A tick that reports green into a void manufactures confidence and is worse than
no tick at all. A failed tick is not a fourth outcome: it is a failure, and it
must fail visibly (non-zero exit, an artifact, or a `skipped` entry that names
the reason). `--check` therefore exits non-zero only for a P0 finding, a usage
error, or a runtime failure; advisory findings remain reportable without
turning the clock red.

## Unattended-safe vs escalate

"Unattended-safe" means a scheduled job may take the action and open a pull
request **without a human in the loop**. It never means the action is merged
without review. This repository has no auto-merger for cadence work.

| Class of action | Unattended-safe? | Limits |
| --- | --- | --- |
| Regenerate `docs/CADENCE_REPORT.md` from the deterministic audit | Yes | PR only; report content is derived, never hand-edited |
| Open a PR with a mechanical, in-range dependency fix that has a test and a passing CI path | Yes | PR only; no `npm audit fix --force`, no semver-major jump |
| Update a derived document or command list to match code | Yes | Only when the source of truth is executable; no prose rewrite |
| Mark a stale ADR reference as superseded or correct a pointer | Yes | PR only; never rewrite the original decision or its rationale |
| Retire a register entry that a newer entry explicitly supersedes | Yes | The supersession must already exist; do not invent one |
| Add, remove, or weaken a lint check, gate, or CI job | **No — escalate** | A doctrine change; needs a human-reviewed PR and a rationale |
| Change audit thresholds, the audit's own rules, or this workflow | **No — escalate** | Self-modification of the verifier is a direction change |
| Change product direction, milestone scope, or deferred work | **No — escalate** | Direction and prioritisation are human decisions |
| Accept a behaviour change, breaking change, or compatibility break | **No — escalate** | Tests can demonstrate a delta, not authorise it |
| Merge any pull request, including a cadence PR | **No — never** | Merging is a human act; no bot approval or auto-merge |
| Approve a review or dismiss a Copilot finding | **No — never** | Approval is a human judgement |
| Push to `main`, force-push a protected ref, or delete data/branches | **No — never** | Irreversible or protected actions |
| Publish a release, package, or Docker image | **No — escalate** | Release workflows are separately gated |
| Make a paid model call, spend AI credits, or send user data externally | **No — escalate** | Must be explicit, scoped, and disclosed |

`autoFixable` in the JSON is evidence that a mechanical fix exists. It is not
permission to apply it. The current workflow only regenerates the report; it
does not ship autofixers. Any future loop that applies a fix must still open a
PR and must remain inside this table.

## Decay policy: registers supersede, never only append

Registers accumulate lies when they only append. The cadence review therefore
treats every register as a current-state document, not a log:

- **The report is replaced, not appended.** Each run renders the current ranked
  list and a `No change recorded` section for clean classes. History belongs to
  git, not to a growing list of stale findings in the report.
- **ADRs supersede by id.** When a decision is replaced, the older ADR records
  `superseded by ADR-NNNN`; the newer ADR records what it supersedes. An
  accepted status must not remain live when a newer accepted ADR says it was
  replaced. The audit reports contradictions and never rewrites them.
- **Checks and jobs retire.** When a check is replaced, the old entry is removed
  or redirected in the same change. Two live entries for one decision are a
  defect, not compatibility.
- **A stale scheduled job is deleted.** A cron that can no longer produce a
  decision, a doctrine change, or a recorded no-change is removed rather than
  left green.
- **"No change" is per tick.** It is recorded in that tick's report and summary.
  It is not accumulated into a permanent green badge.

## Running the audit

```bash
# Human-readable ranked list; local-only, no network.
node scripts/cadence-audit.mjs

# Stable machine envelope: { generatedAt, items, skipped }.
node scripts/cadence-audit.mjs --format json

# The weekly shape; dependency audit is the only network path.
node scripts/cadence-audit.mjs --audit --report docs/CADENCE_REPORT.md

# Gate only on P0 (high/critical dependency advisories today).
node scripts/cadence-audit.mjs --audit --check
```

Options:

- `--format human|json` — output format. JSON stdout contains only the envelope.
- `--report <path>` — write the Markdown artifact inside the repository. The
  file is rewritten only when content changes; the `Generated:` line records the
  last material change, which is what makes byte-identical no-change detection
  honest.
- `--check` — exit 1 only when a P0 exists; usage errors exit 2 and runtime
  failures exit 1.
- `--audit` — run `npm audit --omit=dev --audit-level=high` and fold high and
  critical production advisories into the list. Skipped, and reported as
  skipped, by default.
- `--idle-days <n>` — doctrine-drift threshold, default 90.
- `--adr-age-days <n>` — age before an accepted ADR can be reported as
  contradicted by a newer supersession, default 30.

The four classes are doctrine drift on idle modules, ADR rot, dependency
staleness, and milestone slippage. Milestone data is not machine-readable today:
the audit emits one `needs_manual_review` item naming
[POST_3_DIRECTION.md](POST_3_DIRECTION.md) instead of inventing a parser. Missing
directories, unavailable Git history, and a failed npm audit produce `skipped`
entries, never an unhandled exception.

## Review checks

- [ ] Does every new scheduled job have a declared three-outcome path?
- [ ] Is every autonomous action in the unattended-safe table, and is merging
      still human-only?
- [ ] Does the change retire or supersede the register entries it replaces?
- [ ] Are failures and skips visible, with a reason, rather than silent?
- [ ] Does a clean class record "no change" in the report and the run summary?
