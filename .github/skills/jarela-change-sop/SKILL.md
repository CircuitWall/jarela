---
name: jarela-change-sop
description: "Use when: making code, docs, test, build, or configuration changes in Jarela. Provides the standard operating procedure for scoped edits, branch hygiene, validation, commits, PRs, issue updates, and release-aware change handling."
argument-hint: "Requested change, issue, bug, feature, or PR context"
---

# Jarela Change SOP

## Goal

Make changes in Jarela in a way that is scoped, reviewable, validated, and aligned with the repository's trunk-based workflow.

Use this skill before modifying code, docs, tests, build scripts, GitHub workflows, package metadata, or project configuration.

## SOP

1. Start from the concrete anchor.
   - Use the issue, failing command, failing test, stack trace, file, symbol, or nearby implementation named by the user.
   - If the request is broad, do one targeted search to find the owning code path, then work locally from there.
   - Before the first edit, name one falsifiable local hypothesis and one cheap check that could disprove it.

2. Respect the current worktree.
   - Run `git status --short --branch` before editing.
   - Treat unexpected changes as user work. Do not revert, overwrite, or reformat them unless the user explicitly asks.
   - If unrelated changes are present, leave them alone. If they affect the task, read them and work with them.

3. Keep the edit focused.
   - Fix the root cause when possible, not only the symptom.
   - Prefer existing helpers, stores, schemas, registry patterns, and package boundaries.
   - Do not introduce new abstractions unless they remove real complexity or match an established local pattern.
   - Do not mix unrelated cleanups into the same PR.

4. Honor Jarela architecture rules.
   - Persistent state must go through `lib/db` or `lib/stores`; do not write ad-hoc state outside `JARELA_DB_DIR`.
   - API boundaries require `zod` schemas.
   - Network or external-resource tools must be capability-gated.
   - No telemetry, external analytics, or required cloud calls beyond providers the user explicitly configures.
   - For UX changes, keep the Jarela logo in its established/original placement and preserve its breathing effect unless the user explicitly asks to change the brand treatment or motion behavior.
   - Open an ADR before changing persistence schema or directory layout, adding a provider, introducing a second process, or adding an online-only feature.
   - For Next.js changes, read the local Next docs under `node_modules/next/dist/docs/` before using changed framework APIs.

5. Validate immediately after editing.
   - Run the cheapest behavior-scoped check first: failing test, focused package test, targeted typecheck, or lint for the touched slice.
   - For non-trivial changes, run `npm run check:impact -- --base origin/main --head HEAD` and address or document any ripple-impact follow-ups it reports.
   - If that passes and risk remains, broaden validation in proportion to the blast radius.
   - Let pre-commit hooks run when committing; do not bypass with `--no-verify`.
   - Record commands and results for the PR body.

6. Commit correctly.
   - Use a topic branch based on `origin/main`; never commit directly to `main`.
   - Do not stack meaningless follow-up commits for the same focused topic. If a correction, test fix, wording tweak, or CI repair belongs to the current change, amend the previous commit or use an autosquash fixup before pushing for review.
   - Create a new commit only when it represents a distinct reviewable concern that should remain separate on `main` after the rebase merge.
   - Commit subjects must follow Conventional Commits: `type(scope): imperative description`.
   - Allowed types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
   - Scope is required, lowercase, and single-token.
   - Keep the full subject at 72 characters or less, with no trailing period and no parenthesized asides in the description.
   - Breaking changes need both `!` in the subject and a `BREAKING CHANGE:` footer.

7. Open or update the PR.
   - Push topic branches to upstream `origin` unless the user explicitly says otherwise.
   - Before creating a PR from an existing branch, confirm the intended scope when the branch has mixed commits, already-applied commits, no matching issue/PR, or a compare view that does not clearly describe the desired outcome.
   - If only part of a branch should merge, ask whether to open a clean cherry-picked PR, update the existing branch, or leave it alone.
   - PR title must be a Conventional Commit subject, and so must every commit on the branch — rebase merge lands them all on `main`.
   - PR body should explain what changed and why, plus validation.
   - Use `Refs #<issue>` for partial fixes and `Closes #<issue>` only when merge should close the issue.

8. Close the loop.
   - If the user asked for issue follow-up, comment with the confirmed finding, PR link, validation, and expected timing.
   - If a PR should close an issue, prefer an auto-close keyword in the PR body so GitHub closes it on merge.
   - If a PR was merged without auto-close, verify `mergedAt` before manually closing the issue.
   - After a clean merge, remove residual topic branches locally and remotely when they are no longer needed. Verify the merge first; do not delete branches that still carry unmerged work.

## Quick Checks

```powershell
git status --short --branch
npm run lint
npm run typecheck
npm test --workspace <workspace> -- <focused-test>
npm run check:impact -- --base origin/main --head HEAD
git commit --amend --no-edit
git commit --fixup <commit>
git rebase -i --autosquash <base>
git cherry -v origin/main <branch>
gh pr view <pr> --repo CircuitWall/jarela --json state,mergedAt,url,title
git branch --merged main
git branch -d <branch>
git push origin --delete <branch>
```
