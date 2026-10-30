# ADR-0115: Review each authoring and contribution effect independently

Status: **Implementation; maintainer and release acceptance remain pending**

Date: 2026-10-30

Related: [ADR-0111](0111-dependable-core-user-owned-extensions.md),
[ADR-0114](0114-production-skill-workflow-integration.md), #829, #830.

## Context and decision

Pure scaffold and local diff builders do not provide observed test evidence or
authority to activate or publish code. Complete these workflows through bounded
single-effect services behind the existing pending-action review surface, not
another model runtime. Reuse the checked owned Node runner for reviewed fixture
execution and existing configured drop-in, agent-permission and repository paths.
Do not install packages, change core code, widen allowlists or alter trust policy.

Each operation is bound to the exact artifact/diff, agent, canonical workspace,
destination and observed baseline. Source, configuration, worktree or permission
changes invalidate affected review. Only an unlocked local user approval applies
an operation; agent tools can request, inspect or cancel, never approve it.
Staging, tests, installation, configuration, enablement and actual capability
verification are distinct effects. Contribution tests, commit, push and draft PR
likewise have distinct approvals. Tests/imports/hooks are full-trust execution,
not sandboxed. Missing support or credentials is an explicit blocker.

Executable grants and operation/session state remain bounded and ephemeral.
The existing pending-action table stores identifiers, not runnable snapshots;
authoring results use the existing encrypted-envelope mechanism. Startup fails
abandoned authoring approvals, including unknown outcomes for accepted writes.
Cancellation never rolls back effects. Keep actual host ownership until
settlement and drain it before closing persistence; do not retry an uncertain
remote write based on a cancelled HTTP request or an inferred result.

## Retained source amendment to existing staging ownership

Reuse `skill-runs/run-*` and `skill-run-owners`, rather than introducing another
directory layout. Extend the existing version-1 ownership record's state enum
with `retained`. A separately approved inert authoring stage explicitly retains
its source. Automatic abandoned-run cleanup must report and preserve retained
source even after its original process died. This state grants no execution,
installation or publication authority. Existing prepared/launched/verified
runner cleanup is unchanged. Older versions that cannot parse `retained` fail
closed and retain the directory.

Removal of an installed tool does not delete user-owned staged source. A
separately approved discard can delete only the captured staging directory with
its unchanged identity, never an arbitrary user path. After restart the operator
can inspect retained source and request a new session/review; no consent is
recovered from its ownership record.

Contribution testing uses a user-owned Git topic worktree under the selected
repository's already ignored `node_modules/.cache/jarela-contributions`, not a
new app-state directory. This is a reviewed repository artifact, not durable
executable consent. Operation grants remain ephemeral; ambiguous worktrees are
retained for explicit inspection rather than removed or replayed automatically.
Inert repository discovery disables executable Git helpers. Approved mutations,
hooks, transports and credential helpers use the existing native process owner.
Push is atomic create-only with an empty expected-value lease, so a remote topic
created during review is never overwritten.

## Validation and release boundary

Require actual synthetic-service/loader tests, installation denial, stale review,
failed tests and updates, disable/removal/restoration, repository isolation,
privacy blockers, hook/test failure, missing credentials, cancellation and
single-use approval tests. Execute deterministic successes repeatedly. Verify
local API guards, exact review UI, restart invalidation and owned process cleanup.
Live remote publication requires a separately authorized test repository.
Second-author walkthrough, maintainer ownership and release sign-off remain
human acceptance gates; neither a version number nor green tests substitutes.
