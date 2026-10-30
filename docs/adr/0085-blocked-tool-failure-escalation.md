---
status: accepted
date: 2026-09-09
deciders: Andrew Ge Wu, GitHub Copilot
informed: Jarela contributors
---

# Classify Blocked Tool Failures Before Escalation

## Context and Problem Statement

A valid automation can reach a tool call and fail because of a transient service
problem, local configuration, an invalid contract, or an expected skip. The
existing telemetry aggregates these outcomes by normalized error text, which
makes repeated product failures indistinguishable from routine skips and does
not provide a reliable input for escalation.

## Decision Drivers

* Preserve safe abort behavior for user actions and business-rule skips.
* Keep failure evidence local, bounded, and sanitized.
* Preserve existing telemetry rows and migrate existing databases in place.
* Give future threshold-based issue filing a stable classification contract.

## Considered Options

* Keep free-form normalized reasons only.
* Create a second event ledger for every failed invocation.
* Add a bounded classification to the existing per-tool failure samples.

## Decision Outcome

Chosen option: add a versioned-by-enum `failure_class` to
`tool_failure_samples`, with these values:

* `expected_skip`
* `transient_tool_failure`
* `configuration_problem`
* `suspected_product_gap`

Classification is derived from sanitized error text and the normalized reason.
Existing rows are migrated with the conservative `suspected_product_gap`
default. Reports expose the class and bounded context fields (`workflow_name`,
`event_type`, `extraction_valid`, `intended_tool`, and normalized
`blocked_operation`) so per-pattern escalation can distinguish operational
failures from expected skips without storing raw arguments or user content.

### Consequences

* Good, because recurring contract failures can be selected independently from
  auth, permission, and transient failures.
* Good, because the current bounded sample retention and secret redaction remain
  in place.
* Good, because the migration is additive and preserves existing telemetry.
* Bad, because classification remains heuristic and the context fields are
  only as precise as the turn metadata supplied by the caller; they must not be
  treated as a definitive vendor diagnosis.

## More Information

### Amendment: caller input errors and escalation thresholds (2026-10-30, unreleased)

Explicit tool-input schema rejections and the proxy's `invalid_tool_arguments`
and `bad_args_json` error codes are classified as `caller_argument_error`, with
normalized reason `caller_arguments`. They remain in local usage statistics and
failure samples, but are excluded from complaint drafts and the automatic
global failure metric. Internal or downstream validation errors remain
`validation` / `suspected_product_gap`; the word "validation" alone is not
evidence of a caller mistake.

Existing samples with a recognizable input-schema rejection are reclassified
when read, without rewriting stored evidence or changing the table layout.
Ambiguous historical samples retain their existing classification.

Every product-gap pattern, including internal validation failures, must meet
the configured pattern threshold (default 3) before automatic escalation.
Validation no longer bypasses that threshold. Category, credential, schedule,
and duplicate-report gates still apply.

* `lib/stores/tool-stats.ts`
* `lib/tools/system/tool-telemetry-issue.ts`
* Issue #507
