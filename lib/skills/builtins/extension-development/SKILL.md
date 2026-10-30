---
name: extension-development
description: "Use when: filling an authorized capability gap, scaffolding an extension, reviewing generated plugin code, or planning separate test and installation approval."
---

# Extension Development

Build a user-owned extension through checked stages, not a second agent runtime.
The supported executable path develops a dependency-free CommonJS extension
against the fixed local synthetic-service contract. It does not implement an
arbitrary goal or automatically install generated code.

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
3. Discover `start_extension_authoring`, `request_extension_stage` and
   `inspect_extension_authoring` with their schemas. Initialize a canonical
   absolute workspace. Start with the same discovery input; optional `source`
   replaces only the CommonJS tool, never the fixed fixture assertions.
   The service performs inert syntax checks and captures exact immutable bytes.
   It checks staging is outside every configured tools/providers/skill-repository path.
   Never stage drafts in auto-loaded directories, change core code, expand package
   allowlists or enable unsafe execution. Permission changes require their own
   explicit review; authoring alone grants none.
4. Request `stage` with `{"id":"SESSION_ID","stage":"stage"}`. This only creates
   a pending single-stage approval. The human reviews and decides in the shared
   review banner or Skills > Extension and contribution workflows. After approval,
   inspect the actual retained staging path and revision.
5. Request `test`, separately. It requires exact-source code-execution approval,
   current permissions, execution policy and supported process ownership.
   The service runs fixed synthetic HTTP assertions through the checked owned
   Node runner with bounded output/time and verified descendant cleanup.
   A prompt or typed choice is not consent; never bypass a denied/unavailable checked runner with shell.
   The pure scaffold template has no execution manifest and cannot be passed to `run_skill`;
   the lifecycle service creates the reviewed execution wrapper itself.
   Never label a supplied assertion or scaffold's `not_run` status as test evidence.
6. Adapt only within approved scope. Validate each machine-checkable output with
   code. Show exact source/diff, revision, full-trust import effects, dependencies,
   credential/access requirements and observed tests. Changes invalidate review.
   Real service probes need separate authority; synthetic success is not live
   service certification. Stop after any failed stage.
7. Request `install` only after observed passing tests. Installation and enablement
   are separate approvals for the exact artifact, agent and configured destination. The
   drop-in loader executes top-level code on import; copying into its directory
   is activation, not inert saving. Only the tool source is installed, initially
   disabled for invocation; tests are never installed beside it.
   Request `configure` with an explicit synthetic `fixture_origin`, then `enable`
   separately. Enablement grants only this exact tool to the selected agent and
   enables its existing global drop-in control. No package/trust policy changes occur.
8. Request `verify` and inspect the actual installed tool's checked synthetic
   result, not a catalog entry. For failed update, stop downstream work and request
   `disable`, then authorized `remove`; absence is checked without importing code.
   `restore` disables and selects retained reviewed prior bytes as a new candidate;
   stage, test, install, enable and verify again. It never silently installs or
   claims automatic rollback. Record owner/support/runtime and recovery notes.
9. Inspect each operation with `inspect_authoring_operation`; cancel pending/running
   work with `cancel_authoring_operation` (type `extension`). Cancellation is not
   rollback. In-flight ownership remains until actual settlement; unknown effects
   need read-back. Restart invalidates pending grants and sessions. Retained inert
   staging is user-owned source, not a persistent execution grant.
   Explicitly review `discard` to remove only the current inert staged copy;
   installed code is unchanged and earlier retained versions remain user-owned.

## Validation

Each stage needs explicit input, output and validation criteria. Use
`workflow_progress` for the whole procedure; approvals stay `needs_attention`
with `needs_user: true`. `done` requires observed `validation_evidence`.
Stop on cancellation/denial; never auto-retry an uncertain write. Report partial
effects and reconcile through read-back. Ordinary discovery remains inert.

Contribution is optional and separate. Load `contribution-review` only when the
user requests a local review bundle or explicitly scoped upstream contribution.
Successful local use never grants commit, push, PR or package-publication rights.
