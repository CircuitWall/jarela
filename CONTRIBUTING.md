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
  Every change lands via PR + squash merge.
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
- **scope** — optional, lowercase, single token in `(...)`. Example:
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

Squash merge means the PR title becomes the merge commit subject — so the **PR
title MUST follow the same rules**.

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
5. **Squash and merge.** Squashing keeps `main` history linear and preserves
   the PR title as the commit on `main`, which is what `generate_release_notes`
   reads when assembling the GitHub Release body.
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
| MINOR  | Any `feat:` commit — new user-visible behaviour, new tool, new provider, new integration.                                                                                                                                                                       |
| PATCH  | Only `fix:`, `perf:`, `docs:`, `refactor:`, `chore:`, `test:`, `build:`, `ci:` — no new functionality, no schema change.                                                                                                                                        |

**Pre-1.0 caveat.** Per semver §4, anything in `0.y.z` is unstable. While the
project is in `0.x`, breaking changes bump MINOR (not MAJOR), and the strict
rule above kicks in at the `1.0.0` release.

The version in `package.json` is the source of truth. Tags are derived from
it: tag `vX.Y.Z` MUST point at a commit whose `package.json` reads `version:
X.Y.Z`. The release workflow refuses to publish if they disagree.

## Release process

Releases are **deliberate, tag-driven**, and run entirely from GitHub Actions
once the tag is pushed. No `npm publish` ever runs from a developer machine
after the initial `0.1.2` bootstrap.

### Cutting a release

1. **Open a release PR** from `chore/release-<version>`:
   - Bump `version` in `package.json` to the new `MAJOR.MINOR.PATCH`.
   - In `CHANGELOG.md`, promote `[Unreleased]` entries under a new heading
     `## [<version>] - YYYY-MM-DD`. Keep `[Unreleased]` empty above it.
   - PR title: `chore(release): bump to <version>`.
2. **Merge once CI is green.** Squash merge as usual.
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

### Hotfix releases (PATCH bumps)

Same flow. Branch off `main`, fix, PR, bump PATCH, merge, tag, push.

### Emergency rollback

npm versions are immutable — you cannot republish or replace `X.Y.Z`. To roll
back, cut `X.Y.(Z+1)` with the reverting fix. For npm: `npm deprecate
@circuitwall/jarela@X.Y.Z "use X.Y.(Z+1)"` to nudge installers.

## Release notes

Two sources, with clear ownership:

- **`CHANGELOG.md`** — human-curated, follows
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The release PR
  updates it. This is the canonical narrative for what changed and why a
  user should care.
- **GitHub Release body** — auto-generated by
  `softprops/action-gh-release` (`generate_release_notes: true`). Lists every
  merged PR since the previous tag, by squash-commit title. Use it as the
  raw list; `CHANGELOG.md` is where you write prose for the changes worth
  highlighting.

## Branch protection

`main` is protected on GitHub. The rules in force:

- ✅ **Require a pull request before merging** — direct `git push origin main`
  is rejected.
- ✅ **Require status checks to pass before merging**:
  - `CI / Lint, typecheck, build`
  - `CI / Integration tests`
- ✅ **Require linear history** — only squash or rebase merges are accepted.
- ✅ **Block force pushes.**
- ✅ **Block deletions.**
- ❌ Approving review not required (solo maintainer). Toggle on once you have
  external contributors.
- ❌ Admin enforcement off — the maintainer can break-glass override in an
  emergency.

The tag-push trigger for `release.yml` is unaffected: branch protection
applies to branches, not tags. Tags pushed by a maintainer (or by a future
automation) flow through to the release workflow normally.

## Local development quick reference

```bash
git clone https://github.com/CircuitWall/jarela.git
cd jarela
npm install
npm run setup:hooks
npm run dev          # http://localhost:3000

npm run lint
npm run build
npm run security:ci
npm start            # http://localhost:4312 (prod-mode local run)
npm run test:live    # smoke against the running server
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

# 3. queue auto-merge: GitHub waits for CI green, then squash-merges and
#    deletes the branch. You can close the laptop now.
gh pr merge --auto --squash --delete-branch
```

For a release PR:

```powershell
git checkout -b chore/release-0.2.0
# bump package.json version, update CHANGELOG.md
git commit -am "chore(release): bump to 0.2.0"
git push -u origin HEAD
gh pr create --fill --base main
gh pr merge --auto --squash --delete-branch

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
