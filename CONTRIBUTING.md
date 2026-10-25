# Contributing to Jarela

Thanks for considering a contribution. This document is the single source of
truth for how code reaches `main` and how releases happen. CI enforces most of
it; the rest is on the honour system, audited at PR review.

## Table of contents

- [Branching model](#branching-model)
- [Commit messages](#commit-messages)
- [Pull-request process](#pull-request-process)
- [Versioning](#versioning)
- [Release process](#release-process)
- [Release notes](#release-notes)
- [Branch protection](#branch-protection)
- [Public API surface](#public-api-surface)
- [Workspace packages](#workspace-packages)
- [Local development quick reference](#local-development-quick-reference)

---

## Branching model

Trunk-based development. One long-lived branch.

- **`main`** is always releasable. Every commit on `main` has passed CI and
  could in principle be tagged and shipped.
- **Topic branches** are short-lived and branch off `main`. Name them by
  Conventional Commit type:
  - `feat/<slug>` — new user-visible functionality
  - `fix/<slug>` — bug fix
  - `chore/<slug>` — tooling, infra, refactors with no behaviour change
  - `docs/<slug>` — documentation only
  - `refactor/<slug>` — internal restructuring with no behaviour change
- **Never push directly to `main`.** GitHub branch protection blocks it.
  Every change lands via PR + rebase merge.
- **Delete the topic branch after merge.** Keep `git branch -a` clean.

There is no `develop`, `staging`, or release branch. Releases are tags on
`main`.

## Commit messages

Conventional Commits v1.0.0. Subject line format:

```
type(scope)[!]: description
```

- **type** — one of: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`,
  `build`, `ci`, `chore`. No invented types (no `ui:`, `style:`, `wip:`).
- **scope** — required, lowercase, single token in `(...)`. Example:
  `feat(bridges): …`, `fix(tools/gmail): …`.
- **`!`** — append immediately before the colon to flag a **breaking change**.
  A breaking commit MUST also carry a `BREAKING CHANGE: <migration notes>`
  footer.
- **description** — imperative, lowercase, ≤ 72 chars total, no trailing
  period. Never put `(...)` inside the description.

### Examples

| ✅ Good                                              | ❌ Bad                                            |
|------------------------------------------------------|---------------------------------------------------|
| `feat(agents): add per-agent display filters`        | `Add per-agent display filters`                   |
| `fix(pwa): drop apple-touch-icon transparency`       | `fix(pwa): white background for iOS contrast`     |
| `chore(release): bump to 0.2.0`                      | `release: 0.2.0`                                  |
| `feat(api)!: rename /v1/threads → /v1/conversations` | `feat: rename threads to conversations (breaks)`  |

Rebase merge replays every commit from the PR onto `main` individually, so
**each commit subject must follow these rules**, not just the PR title. The PR
title still matters: it is what `generate_release_notes` lists.

### Pre-commit / PR-title checklist

Before every commit or PR title, verify all of the following:

- The branch is a topic branch, not `main`.
- The subject starts with an allowed type: `feat`, `fix`, `docs`, `refactor`,
  `perf`, `test`, `build`, `ci`, or `chore`.
- A scope is required, lowercase, and single-token: `type(scope): ...`.
- The description starts with a real imperative verb, is lowercase, has no
  trailing period, and keeps the whole subject at 72 characters or less.
- The description does not contain parenthesized asides; use `scope` instead.
- Any breaking change uses both `!` in the subject and a `BREAKING CHANGE:`
  footer with operator migration notes.
- `npm run lint` is clean. Do not carry lint warnings forward as "pre-existing"
  when they are in the touched workflow or block the hook.
- The PR title is exactly the subject you would want to see in the release
  notes, and every commit on the branch is one you want on `main`.

These rules are executable, not advisory: `.githooks/pre-commit` checks the
topic branch, `.githooks/commit-msg` checks the commit message, and CI checks
pull request titles plus post-merge commit subjects on `main`.

The pre-commit hook also runs lint, typecheck, and the unit tests related to
the staged files (`vitest related`, selected by
`scripts/select-precommit-tests.mjs`). Docs-only commits skip tests; changes
to test config, setup files, dependencies, hooks, non-code files, or deleted
modules run the full suite. Set `JARELA_PRECOMMIT_FULL_TESTS=1` to force the
full suite locally. CI always runs the full suite.

When a local commit accidentally lands on `main`, move it to a topic branch
before pushing:

```bash
git switch -c <type>/<slug>
git branch --force main origin/main
git push -u origin <type>/<slug>
```

## Pull-request process

1. **Branch off `main`** with a topic-typed branch name.
2. **Implement and test locally.** Run `npm run lint`, `npm run build`, and the
   relevant tests before pushing.
3. **Open a PR against `main`.** Title in Conventional Commit form. Body
   should explain *what* and *why*; the *how* should be obvious from the diff.
4. **CI must be green** before merge. The `CI` workflow runs:
   - lint (`npm run lint`)
   - typecheck (`tsc --noEmit`)
   - build (`next build`)
   - integration tests (`npm run test:live` against a built server)
5. **Rebase and merge.** Squash and merge commits are both disabled on this
   repository; rebase is the only permitted method and keeps `main` linear.
   Every commit on the branch lands separately, so clean the history up before
   merging rather than relying on a squash to hide it.
6. **Delete the branch.** GitHub offers a button; use it.

Self-merge is fine while Jarela has a single maintainer. Once outside
contributors arrive, flip on "Require at least 1 approval" in branch
protection.

## Versioning

[Semantic Versioning 2.0](https://semver.org/). Format: `MAJOR.MINOR.PATCH`.

Bump rule — pick the **largest** bump triggered by any commit since the last
tag:

| Bump   | Triggered by                                                                                                                                                                                                                                                  |
|--------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| MAJOR  | Any `feat!:` / `fix!:` / `BREAKING CHANGE:` footer. Concretely: removed or renamed env var without fallback, renamed exported symbol, on-disk schema or path change without auto-migration, HTTP/WS contract change, removed public CLI flag.                  |
| MINOR  | Any `feat:` commit that introduces a genuinely new user-facing capability, new tool, new provider, or new integration.                                                                                                                                          |
| PATCH  | `fix:`, `perf:`, `docs:`, `refactor:`, `chore:`, `test:`, `build:`, `ci:`, plus adding, fixing, or completing behaviour inside an already-shipped feature. No breaking schema/API changes.                                                                      |

For unattended Jarela app releases, the nightly policy supersedes the generic
table: 3 or more `feat:` commits since the previous app tag produce a MINOR
release; fewer produce a PATCH release. Breaking changes are held for a human
to prepare the appropriate major release. Workspace packages continue to use
the generic semver table above.

Raising a published package's minimum supported Node version is a breaking
change. Bump each affected workspace package independently: MAJOR for packages
at 1.0.0 or later, MINOR for pre-1.0 packages. Keep the package's `engines`
range, build target, tests, and README runtime requirements aligned with the
app's supported Node lines. Use the `packages` scope for workspace-only
breaking commits; the nightly app-release classifier does not treat these as
app-breaking, because workspace packages use their own versions and tags.

**Pre-1.0 caveat.** Per semver §4, anything in `0.y.z` is unstable. While the
project is in `0.x`, breaking changes bump MINOR (not MAJOR), and the strict
rule above kicks in at the `1.0.0` release.

The version in `package.json` is the source of truth. Tags are derived from
it: tag `vX.Y.Z` MUST point at a commit whose `package.json` reads `version:
X.Y.Z`. The release workflow refuses to publish if they disagree.

## Public API surface

Not every export is part of the package contract. The single source of truth
for what's public is `package.json#exports`:

| Subpath                      | What it exposes                                                              |
|------------------------------|------------------------------------------------------------------------------|
| `./lib/providers/types`      | `ModelProvider` and friends — the contract external LLM providers conform to |
| `./lib/tools/types`          | `OpenAITool`, `ToolContext`, `InvokeMessage`, etc. — the tool authoring API  |
| `./lib/tools/registry`       | `registerTools`, `ToolCategory`, `Capability`, `ToolGroup`, `BuiltinCategory`|
| `./lib/mcp/registry`         | `RegistryEntry`, `RegistryVariable`, `applyVariables`                        |
| `./lib/env/app-config`       | Brand overlay knobs — app name, logo, icons, accent color (ADR-0077)         |
| `./package.json`             | Required by tools that read the package metadata                             |

Anything reachable via the wildcard fallback (`./*`) is **not** part of the
contract — it stays accessible during the pre-1.0 transition but may move,
rename, or disappear without notice between minor versions. ADR-0061 captures
the rationale and the planned 1.0 lock-down.

**Deprecation policy.** Public APIs (per the table above) get one minor
version cycle of deprecation before removal: deprecate in `0.X.0`, remove no
earlier than `0.(X+1).0`. Deprecation lives in JSDoc (`@deprecated since
0.X.0 — use Y instead`) and the CHANGELOG. Internals can change anytime.

**Inside the source tree.** Files marked `@public` in their JSDoc header are
the corresponding implementations. Functions/types tagged `@internal` are
not part of the contract even if they happen to live in a `@public` file —
see `lib/tools/registry.ts` for an example of mixed-tier exports.

## Release process

App releases remain tag-driven and run entirely from GitHub Actions. No
`npm publish` ever runs from a developer machine after the initial `0.1.2`
bootstrap.

### Nightly app releases

At 03:00 UTC, `.github/workflows/nightly-release.yml` checks `main` for commits
since the latest reachable `vX.Y.Z` tag. If there are no new commits, it does
nothing. Otherwise it applies the app versioning rule above and generates the
version bump, changelog entry, and adoption changeset in a `chore/release-*`
PR. Documentation review is optional and never blocks release.
It explicitly dispatches full release-validation CI so validation does not
depend on bot-triggered PR workflows starting. If PR CI also starts, generated
release metadata (including the three adoption files) skips its expensive build,
unit coverage, and E2E jobs; those run once in the dispatched validation instead.
Source or dependency changes still require full PR validation: only the root
manifest and lockfile root versions may change in a metadata-only release.
It rebases and merges only after the required
`Lint, typecheck, build` check and release changeset check pass, then tags the
merged commit and dispatches `.github/workflows/release.yml`.
If tagging fails after the version bump merges, the next nightly run resumes
from that merged release commit after verifying its recorded release base.

Breaking changes are never published automatically. The workflow marks them
for human review and waits for a manually prepared major release. A manual
`workflow_dispatch` of the nightly workflow publishes by default, just like the
scheduled run, after the normal release checks pass. Select **Dry run only**
explicitly to classify changes without creating a release PR or publishing.
Start a new run after changing inputs; **Re-run jobs** retains the original
run's inputs.

Nightly orchestration is unattended after repository permissions are configured:
it dispatches release-validation CI, waits for that run on the exact release
head, verifies its successful build job, and merges only that head. CI
waits are bounded and fail explicitly on timeout; they never bypass
failed checks or request automatic approving reviews. Failed runs may be retried
and reuse a valid bot-owned release PR from this repository, or close a stale PR
for regeneration. Fork PRs are excluded from the release-branch lookup.
Repository rules requiring human approvals or protected-environment approvals
must be satisfied separately; the workflow does not override those policies.
After full dispatched validation passes, nightly approves any contributor-gated
CI run only for the exact same-repository release-bot PR head and CI workflow.
This is workflow execution approval, not a PR review or a repository-wide policy
change. Forks, other actors, other workflows, and changed heads are excluded.
CPU-only CI skips ONNX's optional CUDA download; npm's bundled CPU runtime and
all tests remain enabled.
Release-validation CI also builds smoke-test DEB and RPM installers and verifies
their metadata, extracted payloads, and bundled Node runtime. RPM packaging
preserves prebuilt binaries without generating separate debug packages.

The workflow opens its PR with `GITHUB_TOKEN`, so the repository must enable
**Settings → Actions → General → Allow GitHub Actions to create and approve
pull requests**. If PR creation fails, the workflow deletes the release branch
it pushed so the next run can start clean.

### On-demand release documentation

Documentation generation is **optional and manual only**. Nightly releases and
ordinary CI never invoke Copilot or spend AI credits. Releases do not require a
documentation review, review record, or Copilot token. Skip this entire section
if you only want to publish a release.

One-time setup:

1. Enable Actions PR creation using the repository setting above.
2. Add the Actions repository secret `COPILOT_DOCS_TOKEN`: a fine-grained PAT
   belonging to an account with Copilot CLI access and the **Copilot Requests**
   account permission. Do not grant this token repository-write privileges;
   the separate PR-writing job uses `GITHUB_TOKEN`. Organizational Copilot
   policies must permit CLI use. Never paste the token into a prompt, PR, or log.
3. Check the token owner's Copilot allowance and additional-usage budget.
   The workflow sets `--max-ai-credits 50` (nominally $0.50 at current credit
   pricing), but this is a **soft cap**: a final model response can exceed it.
   Disable paid additional usage if you need to prevent overage charges.
   Standard Actions runners are free for this public repository.

When you want a documentation proposal:

1. Read the intended version from the nightly plan, or choose the human-owned
   major version. Under **Actions > Release documentation > Run workflow**,
   select `main` and enter that stable version, without `v`. Alternatively:
   ```bash
   gh workflow run release-docs.yml --ref main -f version=X.Y.Z
   ```
   This is the only trigger that starts the paid Copilot step. Do not dispatch
   it unless you intend to use the token owner's AI allowance.
2. **Input:** the workflow resolves the previous reachable stable version tag
   and exact main SHA. **Output:** Copilot proposes necessary public Markdown
   edits plus `docs/releases/X.Y.Z.json`. The decision is either `updated`,
   listing documentation actually changed since the previous tag, or
   `unnecessary`, with an explicit substantive rationale. Existing documentation
   updates in the release range can satisfy the updated decision.
3. **Validation:** the workflow rejects non-documentation edits, checks the
   record's version and source, scans for secrets/sensitive terms, opens a PR,
   and explicitly dispatches CI. A maintainer must inspect the documentation,
   evidence, and decision, then merge it. Copilot never approves or merges it.
   The documentation workflow proves record structure and provenance, not
   semantic completeness; ordinary CI does not require review records.
4. Release independently using the nightly workflow with `dry_run=false`,
   or continue the human-owned release. New source, dependency, or configuration
   changes invalidate the optional review; documentation and generated release
   metadata/version-only bumps do not. Neither case blocks publication.

Retries reuse an accepted review or an open PR for the same version and source,
without another AI session. If main advances during generation, the workflow
fails before pushing; dispatch a fresh review. If an older source PR remains
open, close it when replacing it with a current review. If a branch exists
without a PR, inspect/clean up that branch before retrying; it is never
overwritten. After a PR is opened, failed CI dispatch can be retried with
`gh workflow run ci.yml --ref <documentation-branch>` without rerunning Copilot.
Missing credentials, model failures, invalid output, and exhausted allowance
fail the optional documentation workflow explicitly, without blocking releases.

To check a merged review locally (no AI or network call):

```bash
node scripts/release-docs.mjs check X.Y.Z
```

For an audited manual alternative, create the same version-bound record and
documentation edits in a normal PR; this does not require a Copilot credential.
Run `node scripts/release-docs.mjs context X.Y.Z` on the intended source commit
to obtain `version`, `previousTag`, and `reviewedSha`, then copy those exact
values into this record shape:

```json
{
  "schemaVersion": 1,
  "version": "X.Y.Z",
  "previousTag": "vA.B.C",
  "reviewedSha": "the full 40-character source commit SHA",
  "decision": "updated",
  "rationale": "Explain which version-to-version changes were reviewed and why these documentation changes cover them.",
  "documentation": ["README.md"]
}
```

Use `"decision": "unnecessary"` and `"documentation": []` only with a specific
explanation of why no documentation changes are needed. For `"updated"`, list
regular Markdown files actually changed since the previous tag. Commit the
record, run the local check, and have a maintainer review the normal PR.
See [ADR-0106](docs/adr/0106-on-demand-release-documentation.md) for the schema's
trust boundaries and validation limits.

### Human-owned releases

Use this process for breaking/major releases and workspace package releases:

1. **Open a release PR** from `chore/release-<version>`:
   - Documentation proposals above are optional, not a release prerequisite.
   - Bump `version` in `package.json` to the new `MAJOR.MINOR.PATCH`.
   - In `CHANGELOG.md`, promote `[Unreleased]` entries under a new heading
     `## [<version>] - YYYY-MM-DD`. Keep `[Unreleased]` empty above it.
     If users need to change their own setup (agent instructions, skills,
     settings, scheduled task or watcher prompts), add the steps as bullets
     under a `### Adoption` heading in that section.
   - Run `npm run release:changeset` after the bump and CHANGELOG edit, and
     commit `docs/adoption/`. It snapshots every prompt Jarela sends and every
     built-in tool's description and parameter schema, diffs them against the
     previous release, and records the delta with the `### Adoption` hints in
     `docs/adoption/changesets.json`. Version adoption reads this bundled file
     to adapt user setups after an upgrade. A test and the release workflow
     (`npm run release:changeset -- --check`) fail if the step is missing.
   - PR title: `chore(release): bump to <version>`.
2. **Merge once CI is green.** Rebase merge as usual.
3. **Tag `main` and push the tag:**
   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. **The release workflow takes over.** On tag push, `.github/workflows/release.yml`:
   - builds per-OS portable bundles (Linux `tar.gz`, macOS `tar.gz`, Windows `zip`),
   - creates a GitHub Release at `vX.Y.Z` with auto-generated notes,
     attaches the three bundles, the `LICENSE`, and `README.md`,
   - publishes `@circuitwall/jarela@X.Y.Z` to npm **via Trusted Publishing
     (OIDC)**. The publish is signed with sigstore and includes a provenance
     attestation linking the tarball back to this exact tag and workflow run.
     No long-lived `NPM_TOKEN` is involved.
   - publishes `andrewgewu/jarela:X.Y.Z` (+ `:0.1`, `:0`, `:latest`) to
     Docker Hub if `vars.JARELA_DOCKER_PUBLISH == 'true'`.
5. **Verify.** Check that:
   - the GitHub Release page lists three archives,
   - `npm view @circuitwall/jarela@X.Y.Z version` returns the new version,
   - the npm page shows a "provenance" badge,
   - the Docker Hub tag is updated (if enabled).

### Human-owned hotfix and major releases

Same flow. Branch off `main`, fix, PR, bump PATCH, merge, tag, push.

### Emergency rollback

npm versions are immutable — you cannot republish or replace `X.Y.Z`. To roll
back, cut `X.Y.(Z+1)` with the reverting fix. For npm: `npm deprecate
@circuitwall/jarela@X.Y.Z "use X.Y.(Z+1)"` to nudge installers.

## Release notes

Two sources, with clear ownership:

- **`CHANGELOG.md`** — follows
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Nightly app
  releases group Conventional Commit subjects into readable entries; human-
  owned major and workspace-package releases curate the release PR entry.
- **GitHub Release body** — auto-generated by
  `softprops/action-gh-release` (`generate_release_notes: true`). Lists every
  merged PR since the previous tag, by PR title. Use it as the
  raw list; `CHANGELOG.md` is where you write prose for the changes worth
  highlighting.

## Branch protection

`main` is protected on GitHub. The rules in force:

- ✅ **Require a pull request before merging** — direct `git push origin main`
  is rejected.
- ✅ **Require status checks to pass before merging**:
  - `CI / Lint, typecheck, build`
  - `CI / Integration tests`
- ✅ **Require linear history** — only rebase merges are accepted (`squash` and
  `merge commit` are both disabled in repository settings).
- ✅ **Block force pushes.**
- ✅ **Block deletions.**
- ❌ Approving review not required (solo maintainer). Toggle on once you have
  external contributors.
- ❌ Admin enforcement off — the maintainer can break-glass override in an
  emergency.

The tag-push trigger for `release.yml` is unaffected: branch protection
applies to branches, not tags. Tags pushed by a maintainer (or by a future
automation) flow through to the release workflow normally.

## Workspace packages

The repo is an npm workspaces monorepo. The Jarela app lives at the root
(unchanged); standalone `@circuitwall/*` packages extracted from `lib/`
live under `packages/`. See [packages/README.md](./packages/README.md) for
the layout and the rationale.

A single `npm install` at the root installs everything for the Jarela app
plus every workspace package. During development, workspace packages
reference each other with `"workspace:^"` ranges, which npm rewrites to the
published version at publish time — Jarela exercises every package change
immediately via symlink, without a publish cycle.

The Conventional Commits rules and semver rules in this document apply
unchanged to workspace packages. Each package tracks its own version in
its own `package.json` and CHANGELOG. The release-tag convention is
`<package-short-name>-vX.Y.Z` for workspace packages (e.g.
`jira-client-v0.2.0`) so the existing `vX.Y.Z` tag stays unambiguously
the Jarela app's release. Before the first publish of a new package
name, register it with the `@circuitwall` org's OIDC Trusted Publishing
config on npmjs.com (one-time manual step per name).

## Local development quick reference

```bash
git clone https://github.com/CircuitWall/jarela.git
cd jarela
npm install
npm run setup:hooks
npm run dev          # http://localhost:4312

npm run lint
npm run build
npm run security:ci
npm start            # http://localhost:4312 (prod-mode local run)
npm run test:live    # smoke against the running server

# Install this checkout as the autostart service. Builds the working tree
# as-is, uncommitted changes included; re-runs `npm ci` when
# package-lock.json changed.
.\make.ps1 install-service   # Windows
make install-service         # macOS
```

## Solo-maintainer quick PR flow

Branch protection makes direct pushes to `main` impossible, but the round-trip
through a PR can be done in ~30 seconds with `gh` CLI + auto-merge. Use this
when you're the only reviewer.

```powershell
# 1. branch + commit
git checkout -b fix/some-small-thing
# …edit…
git commit -am "fix(scope): describe the change"
git push -u origin HEAD

# 2. open a PR using the commit subject as title and body
gh pr create --fill --base main

# 3. queue auto-merge: GitHub waits for CI green, then rebase-merges and
#    deletes the branch. You can close the laptop now.
gh pr merge --auto --rebase --delete-branch
```

For a release PR:

```powershell
git checkout -b chore/release-0.2.0
# bump package.json version, update CHANGELOG.md
npm run release:changeset
git add docs/adoption
git commit -am "chore(release): bump to 0.2.0"
git push -u origin HEAD
gh pr create --fill --base main
gh pr merge --auto --rebase --delete-branch

# After it auto-merges, on main:
git checkout main && git pull
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

**Break-glass override.** Admin enforcement is intentionally off on `main`.
If CI is wedged and you need to land a fix, you can disable a specific status
check on the protection rule via the GitHub UI (Settings → Branches), merge,
and re-enable. Don't make a habit of it.

See [README.md](./README.md) for the full feature tour and
[docs/INSTALL.md](./docs/INSTALL.md) for end-user install paths.
