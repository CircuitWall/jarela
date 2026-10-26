---
name: documentation-update
description: "Use when: reviewing, verifying, updating, or synchronizing Jarela documentation, surveying all changes since the last documentation update, finding documentation gaps, or aligning docs with app and workspace package versions."
argument-hint: "Documentation scope, target version, or review range; defaults to all changes since the recorded documentation baseline"
---

# Documentation Update

## Goal

Keep documentation aligned with verified implementation and release history.
Distinguish shipped behavior from unreleased changes and record an exact review
boundary so future reviews can identify gaps without repeating the entire audit.

Follow the Jarela Change SOP for worktree safety and scoped edits. This is a
repository-local contributor skill, not an installed Jarela runtime skill.

## 1. Establish scope and versions

- **Input:** User request, worktree status, documentation baseline, app/package
  manifests, changelogs, and Git history.
- **Output:** An explicit target version and a resolvable base/head review range,
  with staged and unstaged changes identified separately.
- **Validation:**
  - Run `git status --short --branch` before editing. Preserve existing work.
  - Read the version scope in [docs/index.md](../../../docs/index.md), the root
    `package.json`, and [CHANGELOG.md](../../../CHANGELOG.md).
  - Read affected workspace packages' own manifests and changelogs; their
    versions are independent of Jarela's version.
  - Unless the user requests a narrower scope, review all repository changes
    since the recorded baseline, not just the selected file or integration.
  - Resolve the recorded commit with Git. If the baseline is absent or invalid,
    identify the last release tag or release commit from history and disclose
    that fallback. Ask if multiple boundaries would materially change the scope.
  - A manifest version alone does not prove release contents: commits after a
    release may retain the same version. Check release history and Unreleased.
  - For a released-version audit, inspect source at the release ref rather than
    treating the current working tree as that release.

## 2. Inventory every change

- **Input:** The verified review range and relevant working-tree diffs.
- **Output:** A change-to-documentation inventory covering every commit and
  changed file in scope, with evidence for each conclusion.
- **Validation:**
  - Inspect `git log` and `git diff --name-status` for the entire range, plus
    staged and unstaged diffs. Do not infer coverage from commit subjects alone.
  - Classify each change as already documented, a documentation gap, historical
    material, or not requiring documentation; record the reason.
  - Check user workflows, UI labels, API contracts, tools and permissions,
    configuration, runtime requirements, installation, dependencies, persistence,
    privacy, architecture, development commands, and release operations.
  - Trace concrete claims to relevant source, schemas, tests, manifests, or
    official external references. Verify external claims against current
    official sources when changing them; record the URL and review date.
  - Keep the inventory in session state or the response unless the user requests
    a report. Do not create a separate planning document in the repository.

## 3. Update the owning documentation

- **Input:** Verified gaps and their release/package scope.
- **Output:** Focused corrections across the relevant documentation surfaces.
- **Validation:**
  - State one falsifiable mismatch hypothesis and its cheap check before editing.
  - Use the documentation map in `docs/index.md` to find the owning guide.
    Update related README, operations, install, development, API, architecture,
    package README, and changelog sections when their claims are affected.
  - Preserve useful documentation for current development, but label unreleased
    features explicitly where readers encounter them. Do not imply they shipped
    in the last release or invent a future version number.
  - When released and development requirements differ, state both scopes
    explicitly, especially Node requirements and package feature availability.
  - Mark documentation without an established release scope as unversioned;
    do not manufacture a version guarantee.
  - Update architecture diagrams as well as prose when boundaries or external
    dependencies changed.
  - Preserve historical context in ADRs and journals. Add a supersession note
    or amendment when needed rather than rewriting history as current guidance.
  - Respect generated-file notices. Use existing generators for adoption data
    and release snapshots; do not manually rewrite generated release history.
    `docs/CHANGELOG.md` is copied from the root changelog by `docs:sync-assets`
    during site builds; edit the root source, not the generated site copy.
  - Reuse the established baseline in `docs/index.md`; do not add competing
    app-wide review markers to unrelated package READMEs.

## 4. Validate and record the boundary

- **Input:** Updated docs and the change-to-documentation inventory.
- **Output:** Validated documentation, an accurate review baseline, and a concise
  summary of changes, checks, and unresolved gaps.
- **Validation:**
  - Reconcile the inventory: every in-scope change needs a documented disposition.
    Sampled reads or keyword searches alone do not establish complete coverage.
  - Run `git diff --check`; inspect the final diff and changed-file status.
  - Verify modified relative links, headings, version numbers, command names,
    and consistency between summaries and detailed guides.
  - Use existing documentation checks/builds when relevant, especially for
    navigation or site configuration changes. Inspect configured commands first;
    do not install tooling merely for prose edits or run unrelated app tests.
  - Do not claim a command, workflow, release, or feature was tested if it was
    only read. Report validation failures and unknowns explicitly.
  - Advance the app-wide baseline only after a complete survey. Record the
    app release version, exact reviewed code commit, review date, and whether
    unreleased changes are included. A partial review must retain the previous
    full baseline and disclose its narrower scope.
  - A date or version bump alone is not a documentation review. Never move the
    baseline past unreviewed code, and do not change package versions solely to
    make documentation appear current.
  - Finish with the reviewed range, changed docs, validation results, and any
    remaining gaps. Do not commit or publish solely because a skill was created.

## CI and release-documentation alignment

Treat the checked-in workflows and validator as authoritative; read them before
choosing checks because their path filters and review contract can change:

- [CI](../../workflows/ci.yml)
- [Documentation site deployment](../../workflows/docs-site.yml)
- [Optional release-documentation workflow](../../workflows/release-docs.yml)
- [Release-documentation validator](../../../scripts/release-docs.mjs)
- [Maintainer procedure](../../../CONTRIBUTING.md#on-demand-release-documentation)

### Ordinary documentation updates

- **Input:** Changed paths and current workflow filters.
- **Output:** Checks matching the affected CI surfaces, without making optional
  AI generation a release prerequisite.
- **Validation:**
  - CI always scans tracked files for secrets and sensitive terms. Run
    `npm run security:secrets` and `npm run security:terms`; explicitly scan new,
    untracked files too, since `--all` covers tracked files only.
  - Root Markdown and `docs/` edits do not trigger the expensive app build job.
    Changes under `packages/`, including package READMEs, do match CI package/app
    filters. Do not promise that every Markdown-only PR skips app checks.
  - For site content, navigation, or configuration changes, run
    `npm run docs:build`, the same Zensical build used by site deployment.
    Dependencies come from `requirements-docs.txt`; report unavailable tooling
    rather than claiming a successful build.
  - The site deploys on main pushes or manual dispatch, not as a PR CI job.
    Local checks do not prove that Pages deployment or remote CI succeeded.
  - Keep normal branch, commit, and PR conventions. Do not modify workflows,
    weaken checks, or add a paid/mandatory documentation gate to complete a review.

### Formal version-to-version release review

- **Input:** An explicitly intended stable app release version and source ref.
- **Output:** Documentation plus a validator-compatible review record, only when
  the user requests a formal release review.
- **Validation:**
  - Run `node scripts/release-docs.mjs context X.Y.Z <source-ref>` first.
    Use its exact `version`, `previousTag`, and full `reviewedSha`; review the
    entire previous-tag-to-source range, not just the human-readable baseline.
    Do not invent a tag or bypass a context failure.
  - Create `docs/releases/X.Y.Z.json` with `schemaVersion: 1`, those exact context
    fields, `decision`, a substantive `rationale`, and `documentation`.
    Use `updated` with unique allowed Markdown paths actually changed since
    the previous tag, or `unnecessary` with an empty list and a specific reason.
  - The proposal validator permits only root README/CONTRIBUTING, eligible
    Markdown under `docs/`, package READMEs, and the requested review record.
    Root CHANGELOG, skill files, workflow edits, and package manifests are not
    allowed proposal outputs. Keep such work separate; never hide unrelated
    changes or force this mixed worktree through the proposal validator.
  - Before committing an isolated proposal, run
    `node scripts/release-docs.mjs proposal X.Y.Z <reviewedSha>` and diff/safety
    checks. After the record is committed, run
    `node scripts/release-docs.mjs check X.Y.Z`; it reads committed Git objects,
    not the uncommitted record.
  - New source, dependency, or configuration changes invalidate the review.
    Only exceptions implemented in the validator may follow the reviewed SHA
    without requiring another review. A landing-page baseline is not a
    substitute for this record, and structural validity is not semantic proof.
  - Documentation generation remains optional and manual. Do not dispatch
    `release-docs.yml` without explicit authorization for paid Copilot usage.
    A local manual review requires no Copilot token.
  - The automated workflow uses a separate human-reviewed PR and explicitly
    dispatches CI because GITHUB_TOKEN-created PRs do not trigger PR workflows.
    Do not auto-approve/merge, claim checks passed without observed results, or
    dispatch a new paid generation merely to retry failed CI.
