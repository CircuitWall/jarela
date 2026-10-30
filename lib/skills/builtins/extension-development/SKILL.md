---
name: extension-development
description: "Use when: filling an authorized capability gap, scaffolding an extension, reviewing generated plugin code, or planning separate test and installation approval."
---

# Extension Development

Build a user-owned extension through checked stages, not a second agent runtime.
This initial authoring slice generates an inert local synthetic-service template;
it does not implement an arbitrary goal or automatically install generated code.

## Input

An authorized goal, discovered capability-gap evidence, selected extension
surface/workspace, expected inputs/outputs and access limits. Missing credentials,
denial or service outage are setup/access problems, not permission to author a
bypass. Ask for unresolved scope, account and ownership choices.

## Output

A revision-bound source/test/setup/recovery artifact and observed validation
evidence, or an explicit blocker. Keep untested, pending and unknown states
visible. Generated/adapted code is model-generated until independently checked.

## Procedure

1. Discover configured tools with `list_tools` and supported surfaces with
   `describe_extension_surfaces`. Read the documented contracts and available
   packages; prefer reuse or configuration before authoring. Inspection itself
   must not import unknown plugins or run install hooks.
2. Discover `scaffold_extension` with `list_tools` and `include_schema: true`.
   For a genuine authorized gap, pass the observed decision and non-sensitive
   evidence. Example:

   ```json
   {"name":"fixture_echo","goal":"Read a value from a local synthetic service","discovery":{"decision":"author","evidence":"No configured tool handles this fixture"}}
   ```

   Check `ok`, `revision`, `files` and `validation.status`. The result is only a
   fixed dependency-free CommonJS synthetic-loopback template, not completion of
   the goal. The tool returns text: no files, imports, tests or installation occur.
3. Before any authorized file writes, verify an explicitly selected staging
   directory is outside every configured tools/providers/skill-repository path.
   The suggested relative directory is not a verified workspace. Never stage
   drafts in auto-loaded directories, change core code, expand package allowlists,
   enable unsafe execution or increase permissions.
4. Review source statically. After separate code-execution authorization, run
   the generated Node test through an available authorized executor. Do not treat
   a prompt or typed choice as execution consent. Missing supported execution
   is a blocker; never bypass a denied/unavailable checked runner with shell.
   The template has no execution manifest and cannot be passed to `run_skill`.
   Preserve actual command, runtime, exit status and checked fixture result.
   Never label a supplied assertion or scaffold's `not_run` status as test evidence.
5. Adapt only within approved scope. Validate each machine-checkable output with
   code. Show exact source/diff, revision, full-trust import effects, dependencies,
   credential/access requirements and observed tests. Changes invalidate review.
   Real service probes need separate authority; synthetic success is not live
   service certification. Stop after any failed stage.
6. Installation and enablement are separate approvals for the exact artifact,
   agent and destination. Use existing supported lifecycle controls only. The
   drop-in loader executes top-level code on import; copying into its directory
   is activation, not inert saving. Never install the fixture test beside it.
   If no separately approved supported install path is available, retain the
   inert artifact and report the blocker.
7. Verify the actual capability result after installation under the selected
   agent permissions. For failed update, stop downstream work, disable via
   existing controls and verify absence after authorized removal. Restore only
   reviewed prior bytes with new approval and observed verification; do not
   claim automatic rollback. Record owner/support/runtime and recovery notes.

## Validation

Each stage needs explicit input, output and validation criteria. Use
`workflow_progress` for the whole procedure; approvals stay `needs_attention`
with `needs_user: true`. `done` requires observed `validation_evidence`.
Stop on cancellation/denial; never auto-retry an uncertain write. Report partial
effects and reconcile through read-back. Ordinary discovery remains inert.

Contribution is optional and separate. Load `contribution-review` only when the
user requests a local review bundle or explicitly scoped upstream contribution.
Successful local use never grants commit, push, PR or package-publication rights.
