---
name: module-review
description: "Use when: reviewing a Jarela change across one or more modules. Maps changed files to their owning Agent.md guides, generates portable review briefs, dispatches read-only reviewers, and consolidates evidence-backed findings."
argument-hint: "Review target: staged, base/head range, branch, or pull request; defaults to the working tree against HEAD"
---

# Module review

## Goal

Review a change against each touched module's guide without making the lead
agent hold the whole repository in context. The deterministic gate stays
authoritative; reviewers add judgment that scripts cannot verify.

Protocol: [docs/MODULE_REVIEW.md](../../../docs/MODULE_REVIEW.md).

## SOP

1. Establish the range. Use `--staged`, `--base <ref> --head <ref>`, or the
   default working tree.

2. Generate the work orders:

   ```sh
   npm run review:module -- <range> --json --briefs <dir-outside-the-repo>
   ```

3. Dispatch one read-only reviewer per module brief. Give it the brief path and
   tell it to read `AGENTS.md` and the guide named in the brief. Use the
   harness's subagent mechanism when available; otherwise run the briefs
   sequentially in one session.

4. Consolidate before editing:
   - Mechanical gate failures are facts; fix them or explain why the rule does
     not apply.
   - Confirmed reviewer findings come next, then suspected ones.
   - Deduplicate by rule and location.

5. Validate after edits:

   ```sh
   npm run review:module -- <range>
   npm run check:impact -- --staged
   npm run lint
   ```

## Rules

- Reviewers are read-only. They report, they do not edit.
- Every confirmed finding cites a file and line, a test result, or command
  output. A clean report lists the claims checked and commands run.
- Code is authoritative for behavior; the guide is authoritative for policy.
  State which side should change.
- Do not fan out for a single-module change. Use Tier 0.
- Do not rely on auto-loading. The brief names the guide for a reason.
