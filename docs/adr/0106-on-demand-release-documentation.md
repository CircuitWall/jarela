# ADR-0106: On-demand Copilot release documentation reviews

Status: Accepted

## Context

Version adoption changesets describe prompt and tool-schema changes, not whether
the public manuals cover a release. Maintainers may request documentation review
between versions, without scheduled AI costs or AI self-approval. Documentation
review is optional and must not prevent publication.

## Decision

Add a manually dispatched Release documentation workflow. A maintainer supplies
the intended stable app version. A pinned Copilot CLI compares the previous
reachable stable tag with an exact main commit and proposes Markdown edits and
a structured review in `docs/releases/<version>.json`.

Use a separately configured Copilot-enabled token only in the read-permission
generation job. The normal Actions token cannot authenticate Copilot. Do not
give the model PR, merge, or publishing authority. Disable built-in MCP,
repository custom instructions, session sync, and automatic updates; allow
file editing and read-only git inspection commands. Independently validate the
output scope and source binding before passing a patch to a separate PR-writing
job, which revalidates it and scans for sensitive information.

Only explicit workflow dispatch can consume AI credits. Reuse an accepted review
or an existing PR for the same source without another AI session. Set a
50-AI-credit session soft cap and a job timeout. The CLI checks costs after model
responses, so this is not a hard dollar ceiling; account-level paid-usage budgets
remain the operator's responsibility.

The record identifies the version, previous tag, reviewed source SHA, a
substantive rationale, and either changed documentation or an explicit
`unnecessary` decision. A maintainer reviews and merges the PR; neither decision
is automatically approved. Records are Git-tracked release metadata, not app
state, and add no runtime cloud dependency.

Nightly preparation, resume/tagging, ordinary CI, and app-tag publication do not
require a record or Copilot credentials. Record validation belongs only to the
optional documentation workflow and local checks. New source changes invalidate
an optional review; Markdown documentation,
the record itself, generated adoption metadata, and package-version-only bumps
may follow the reviewed source without requiring another AI review. Changed
dependencies and other source/configuration changes invalidate it. Workspace
package tags keep their existing release process. Missing, stale, or failed
documentation reviews never block a release. This replaces the initial mandatory
release-gate policy at the maintainer's request.

## Validation

Deterministic tests cover missing/invalid/stale records, ancestry, previous-tag
selection, actual documentation changes, package metadata exceptions, proposal
scope, PR validation, and on-demand-only workflow wiring. The assembled prompt is
registered for inspection. These checks establish provenance and structure, not
semantic documentation completeness or model obedience. Maintainer review and
an authenticated, explicitly requested Actions run are required for those
remaining operational checks.
