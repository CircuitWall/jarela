# ADR-0112: Checked JavaScript skill execution

Status: **Proposed; implementation blocked on boundary review**

Date: 2026-10-28

Related work: [W0 / 3.1.0](https://github.com/CircuitWall/jarela/issues/826),
[W1 / 3.1.0](https://github.com/CircuitWall/jarela/issues/827),
[R7](../POST_3_DIRECTION.md#r7-script-backed-skills), [ADR-0111](0111-dependable-core-user-owned-extensions.md).

## Context

The W0 baseline finds a Markdown skill loader, a read-tool fixture runner,
shell-based execution, configuration approvals and progress/retry helpers.
None supplies a checked, artifact-bound JavaScript execution contract.

The [terminal session](../../lib/terminal/session.ts) accepts shell text and
its timeout path resolves without establishing process-tree termination.
The [subprocess environment](../../lib/tools/security/subprocess-env.ts)
intentionally inherits shell/process variables and injected credentials.
Those are existing terminal contracts, not defaults to silently apply to
user-authored skill code.

## Proposed first-slice contract

This is a review proposal, not a supported file format or execution permission.
No loader, tool, approval action or database change is introduced by this ADR.

### Run-scoped lifecycle decision (2026-10-28)

The maintainer selected **run-scoped snapshots and one-use consent** for the
first runner, rather than durable snapshots or resumable approvals. This selects
the lifecycle direction; it does not accept the entire runner proposal or
remove the process-cleanup and approval-integration gates below.

- A live run owns one consent instance. Bind every proposal to the exact agent,
  run, resolved workspace, verified artifact revision, invocation bytes, runtime
  version and execution/output limits. Every change requires fresh consent.
- Use a five-minute consent window, measured against a monotonic clock. The
  displayed creation/expiry timestamps use wall time; clock changes must not
  extend consent. Bound retained metadata to 64 proposals per run and reject
  excess explicitly. A replacement proposal stales pending/approved predecessors.
- Decisions are pending -> approved/denied; only approved consent can be consumed,
  synchronously and once. Expiry, changed binding or policy refusal are terminal
  for that proposal. Duplicate/conflicting decisions are errors, not approval.
- Aborting or completing the run cancels outstanding consent. Recreated run
  instances, including after app restart, cannot recover old grants. There is
  no automatic retry or resume. An already consumed grant does not prove that
  the script started, completed, or had its side effects rolled back.
- Snapshot bytes must ultimately be staged in a private run-owned location
  under the configured data directory through the appropriate lifecycle owner.
  Do not persist/recover runnable grants in SQLite or execute a surviving
  staging directory on startup. Actual placement, protection, source capture,
  crash-leftover cleanup and retention remain implementation gates; this
  increment creates no directories or database schema.

The internal `lib/skills/execution-consent.ts` primitive implements the in-memory
binding/state transitions and bounded invocation digest, with deterministic
tests. It is **not wired to a tool, approval endpoint or runner**. A supplied
artifact hash does not establish a verified immutable snapshot; an absolute
workspace string does not establish filesystem identity. The future caller must
capture/verify the snapshot, resolve/recheck workspace identity, validate input
against the manifest schema, obtain the human decision through the existing
approval lifecycle, and recheck policy immediately before spawn.

Consent metadata stores only the invocation digest, not raw arguments or code.
The eventual consent UI must separately show the exact arguments, artifact,
workspace, limits and full-trust warning. This module is not a sandbox or an
independent authorization boundary.

### Security-settings consent policy amendment (2026-10-28)

The maintainer approved managing script consent in Security settings. Persist
the selected policy and up to 64 exact revision trust scopes in the existing
`memory_store` app-settings namespace (`skill_execution_policy`); no new tables,
data-directory layout or runnable snapshots are introduced.

- Default to **Ask each time**. **Blocked** denies scripts; **Approve a workflow
  run** requires an independently verified, bounded plan and run-scoped consent,
  never a blanket session grant. Missing workflow authorization must not execute.
- **Trust selected revisions** may waive repeated consent only for an exact
  verified artifact revision, agent and resolved workspace, within explicit
  timeout/output ceilings. Unmatched/changed revisions require invocation consent.
  Trust intentionally covers different valid inputs within that scope; it is
  durable across restart, unlike a pending or one-use run consent.
- Record each approved checksum scope with a server-issued UUID and UTC approval
  timestamp. Preserve the receipt for unchanged scope/ceilings across saves and
  restarts. Ignore submitted receipt identity/time; callers cannot mint them.
  Changed revision, agent, workspace or ceilings gets a new receipt when the
  local user explicitly saves trusted-revision mode. Entries saved in other
  modes without a receipt remain unapproved drafts. A version label is not an
  authorization identity; the verified bundle checksum is authoritative.
  Removing an entry revokes it; re-adding creates a new approval record.
  These are active approval records, not an immutable historical audit ledger.
- The local unlocked user manages this policy through the Security UI/API.
  No agent tool or skill metadata can write it. The route uses the existing
  loopback guard, lock checks and request-origin proxy; this is not isolation
  from arbitrary code already running as the same OS user.
- Safe mode and execute capability are checked independently for every launch.
  Neither `mostly_safe` nor `bypass` implies consent. Policy is read again
  before launch so removal/blocking takes effect for future launches. This
  setting cannot stop an already running full-trust script; cancellation and
  process ownership remain runner responsibilities.
- The initial settings increment persists/revokes trust and evaluates consent
  requirements only. It adds no runner, verified workflow plan, snapshot capture
  or human-approval endpoint. The UI must explicitly say execution is unavailable.
  Trust is not a filesystem/network sandbox; scripts run as the app's OS user.

### Unreleased inspection-only increment

The opt-in `read_skill` execution inspection implements inert structural
checks from this proposal, not execution or approval. See the
[extension guide](../EXTENDING.md#inspecting-skill-execution-metadata-unreleased).
The selected Markdown source and repo precedence remain authoritative;
flat skills do not acquire a neighboring folder's manifest. Every inspection
result says `execution_available: false`.

The inspector uses strict Zod schemas, a 64 KiB bounded UTF-8 manifest reader,
32-level/4,096-node JSON limits and metadata checks for up to 64 declared files
(1 MiB each, 4 MiB total). Its schema subset requires explicit object property
maps and array items; scalar enums and boolean `additionalProperties` are
supported. It rejects unknown keywords rather than resolving references or
evaluating code. These are experimental inspection choices, not acceptance
of the runner contract below. The inspector does not validate invocation/results,
produce an immutable snapshot, establish process cleanup or authorize code.

### Shared-bundle portability requirement

Amendment (2026-10-28): target one shareable
[Agent Skills](https://agentskills.io/specification) directory for Jarela,
Claude Code and other hosts implementing that format, rather than a
Jarela-only skill package. This is a required design target, not a claim that
the current loader implements the full standard or that cross-host execution
has been verified.

The portable source layout is:

```text
example-skill/
  SKILL.md
  scripts/
    run.mjs
  references/
    REFERENCE.md
  assets/
    template.json
  execution.json
```

Only `SKILL.md` is required. Supporting directories are optional conventions;
`execution.json` is an optional Jarela extension, not part of the shared
standard. The same source directory must remain usable by another host
without generating a second instructions file or converting the source.

1. Use standard YAML frontmatter with folder-matching `name` and a descriptive
   `description`; preserve optional `license`, `compatibility`, `metadata` and
   `allowed-tools` fields and additional host-specific fields without rewriting
   the original document. Validate against the published standard, not the
   current loader's limited frontmatter parser or 200-character catalog preview.
   Legacy flat Markdown remains a Jarela compatibility path, not a portable
   standards-conformance claim.
2. Resolve referenced resources relative to the selected skill root, regardless
   of the app working directory. Load references/assets on demand. Preserve
   relative paths and file contents when sharing; do not strip files just
   because they are not executable-manifest entries. Reject unsafe paths/links
   explicitly rather than silently dropping content or escaping the bundle.
3. Keep reusable scripts independent of Jarela internals. Document their
   runtime, dependencies and invocation in the shared instructions so another
   host can use them with its own tools. The first Jarela checked-runner slice
   remains dependency-free `.mjs`/`.cjs` with the JSON protocol below; sharing a
   Python or shell script does not add support for executing it in that runner.
4. Treat the optional manifest as a Jarela execution adapter over those same
   files. Absence or rejection of the manifest must not prevent ordinary
   prompt-only discovery. Do not generate a manifest, install dependencies or
   execute scripts merely because a shared skill was found.
5. Separate format support, resource availability and execution support.
   Report unsupported runtimes, missing tools and unsupported host behavior
   explicitly before relying on them. Claude-specific invocation controls,
   dynamic command injection and subagent settings are not automatically
   implemented or translated into executable behavior. Preserve their source
   fields; never claim their semantics are enforced when they are not.
6. Skill metadata is not authority: `allowed-tools`, compatibility declarations
   and another host's approvals cannot grant Jarela permissions. An unavailable
   checked runner is not permission to fall back silently to terminal execution.
   A Jarela-specific skill may still require Jarela tools; mark that requirement
   rather than advertising universal behavioral portability.

Acceptance requires a synthetic standard-format bundle with instructions,
relative references, assets and a dependency-free script. Verify identical
source files in Jarela and Claude Code (record host versions), reference
resolution from a different working directory, and the same expected script
result under each host's own authorized execution path. Also verify Jarela
prompt-only discovery without a manifest, source preservation with unknown
host fields, explicit unsupported-feature diagnostics and no metadata-driven
permission escalation. Other hosts need their own named validation evidence;
format similarity is not cross-host certification. These checks complement,
not replace, the runner's failure and authorization tests.

Sources reviewed on 2026-10-28: the
[Agent Skills specification](https://agentskills.io/specification) and
[Claude Code skills documentation](https://code.claude.com/docs/en/skills).

### Jarela execution bundle and protocol

- Preserve existing `SKILL.md` discovery, flat Markdown and repo precedence.
  Listing/reading never imports code, runs hooks or installs dependencies.
- Opt in to execution with a separate strict JSON manifest, `execution.json`,
  schema version `1`. Unknown fields and versions are errors on inspection for
  execution; prompt-only discovery remains independent of this manifest.
- Initial fields: `schemaVersion`, `entrypoint`, `files`, `inputSchema`,
  `outputSchema`, `timeoutMs`, `maxOutputBytes`. Entry point must be included in
  the file list. Enforce unique portable relative paths, bounded file count and
  bytes, and reject absolute paths, traversal, links and special files.
- Support explicit `.mjs` (ES modules) and `.cjs` (CommonJS) only. Defer ambiguous
  `.js`, direct TypeScript, Python, shell entry points and dependency installation.
  Node built-ins and listed relative code are supported authoring surfaces;
  app-private imports and ambient packages are not a supported skill API.
  This authoring contract is not an import sandbox.
- Run the app's `process.execPath` with an argument array and `shell: false`.
  No model/user string is interpolated into shell text. Do not accept custom
  Node flags, interpreter paths or arbitrary command strings.
- Send one UTF-8 JSON object on stdin, then close it. The script emits exactly
  one JSON value on stdout; diagnostics go to stderr. Validate invocation and
  result separately. Zero exit plus invalid/missing output is failure.
- Start with a bounded JSON Schema subset: objects, arrays, strings, numbers,
  integers, booleans, null, required properties, enums, `additionalProperties`,
  and length/item/numeric bounds. Reject unsupported schema keywords rather
  than pretending to enforce them. Define precise nesting and total-node bounds
  before implementing the validator; reuse installed validation support where
  it actually enforces this contract.

### Proposed numeric bounds

These are candidates for explicit review and boundary tests, not current
configuration defaults. Reject out-of-range values; do not silently clamp.

| Resource | Default | Permitted maximum / rule |
| --- | --- | --- |
| Manifest | No default | 64 KiB UTF-8 |
| Bundle | No default | 64 regular files, 1 MiB per file, 4 MiB total |
| Invocation JSON | No default | 64 KiB UTF-8, excluding transport framing |
| Execution timeout | 60,000 ms | Integer 1,000-120,000 ms |
| Stdout JSON | 64 KiB | Integer 1-256 KiB; excess fails, never parses truncated JSON |
| Stderr diagnostics | 16 KiB | Fixed bound; excess terminates as output-limit failure |
| Termination grace | 1,000 ms | Afterward force termination; unresolved descendants mean cleanup failure |
| Automatic attempts | 1 | No automatic retry of skill execution in W1 |

Raw stdout/stderr must remain bounded while streaming, not just clipped after
the child finishes. Errors/cancellation/timeouts/nonzero exit remain non-success
even if a partial JSON value was emitted.

### Internal protocol-validation increment (2026-10-29)

`lib/skills/execution-protocol.ts` implements pure, bounded invocation/result
validation against the inspected schema subset, with no runner, new approval
kind, snapshot storage or automatic execution. It reuses the existing JSON
depth/node limits and is shared by consent's exact-byte invocation digest.
Input is capped at 64 KiB; result text uses the parsed manifest's output limit.
Values are not coerced or stripped; undeclared properties are allowed unless
explicitly forbidden, and string bounds count Unicode code points. The manifest
parser rejects reserved `__proto__` schema keys explicitly instead of accepting
a silently altered definition. Tests cover each constraint, exact size/depth/node
boundaries, multiple JSON values, non-finite numbers and prototype-looking keys.

This is an internal contract increment, not acceptance of the full proposed
execution boundary or proof of any script journey. The future transport still
must enforce byte limits during capture, valid UTF-8, exit/timeout/cancel status,
immutable artifact identity and authorization before using validated output.
The [extension guide](../EXTENDING.md#internal-invocationresult-validation-unreleased)
records the implemented subset and outstanding runtime responsibilities.

### Memory cleanup candidate increment (2026-10-30)

Implementation has started with the existing read-only Memory Organization
planner as the first executable-bundle candidate. Its `execution.json` declares
the two existing portable scripts, exact fact projections, nullable expiry,
success/field-error output shapes and 5,000 ms / 64 KiB limits. No new algorithm,
database access, production staging or execution tool is added.

The internal schema subset now additionally supports `anyOf` with two to four
branches. This narrowly extends the earlier combinator rejection: each branch
must itself satisfy the strict bounded subset, alternative nodes reject sibling
keywords, and the invocation root remains an explicit object. Existing JSON
depth/node limits cover all branches. Matching any branch passes without
coercion; total failure reports one issue at the original path, bounded by the
existing 20-issue limit. Semantic UTC dates, trimmed text limits and duplicate
keys remain the shared planner's responsibility, not newly claimed schema checks.

Contract tests use captured bytes in test-only temporary locations and real
Node subprocesses, checking valid and field-error fixtures against the manifest
and fixed typed tool. They also check source-change independence, empty PATH,
paths with spaces/metacharacters and maximum record counts. These tests are not
the proposed production snapshot/consent/cleanup implementation or a full W1
journey. Execution inspection remains unavailable, and all outstanding
boundary-review and cross-platform acceptance gates below remain in force.

### Identity, authority and lifecycle

#### Raw-output transport increment (2026-10-30)

The internal `SkillExecutionOutput` helper now bounds copied stdout bytes at
the parsed manifest limit and stderr at 16 KiB while incrementally validating
strict UTF-8. Fixed-capacity buffers avoid unbounded chunk-list overhead.
Finalization rejects incomplete encoding and validates the complete JSON value
through the existing protocol validator. Overflow is never clipped into a
success result; the first error is terminal, and disposal clears/releases
retained byte buffers. Structured error codes do not echo raw script output.

Tests cover exact/excess stream ceilings, single-byte and varied chunking,
malformed/partial Unicode, JSON/schema errors, mutation of caller buffers and
manifest, and terminal/disposal states. Ten fresh reviewed built-in CLI processes
exercise actual raw pipes and both zero/nonzero field-validation exits.
These are not arbitrary-code launch or descendant-cleanup tests.

The helper does not spawn/stage code, enforce execution deadlines, grant consent,
observe exit status or establish process-tree ownership. Its returned checked
value is only protocol evidence, never execution success. The unresolved
production owner must dispose on failures, terminate/reap the whole tree and
verify all lifecycle facts before exposing a successful execution envelope.
No boundary approval was available during this increment; production execution
and durable-workflow activation remain blocked, not implicitly approved.

- Build a private run snapshot using safe file operations; hash the manifest,
  instructions, declared code/data and validators. Review/authorize the immutable
  snapshot identity, not a mutable source path. Execute that snapshot only.
  Fail on missing/changed files or unsafe links; test concurrent source mutation.
- Separate immutable bundle content from the authorized writable workspace.
  Content-addressed naming alone does not make a directory immutable.
  Snapshot placement, retention and protection against replacement need review
  under the existing data-directory/store rules before any persistence changes.
- Require the caller's explicit execute capability and current safety policy.
  Safe mode must reject scripts. Add artifact-scoped consent through the
  existing approval lifecycle only after defining agent/run/input/workspace/
  revision binding, expiry, decision races, cancellation and restart handling.
  Reading/writing a skill, an earlier approval for another revision, or answering
  a workflow question does not grant consent.
- Show the full-trust host-code warning, exact artifact, arguments, workspace,
  limits and environmental access before consent. There is no host sandbox:
  arbitrary Node code can access host files/network under the app's OS identity.
  Hashes, capability metadata and a minimal environment do not prevent that.
- Do not inherit the full shell/credential environment. Review a small
  cross-platform launch-variable allowlist and remove injection variables such
  as `NODE_OPTIONS`/`NODE_PATH`; no caller-supplied environment in W1.
  Credential resolution is deferred for the dependency-free first fixture.
- Observe abort before spawn and during execution. On timeout, cancellation,
  excessive output or failure, terminate the owned process tree and confirm
  cleanup before reporting a terminal result. Document Windows/POSIX behavior
  separately; killing only the immediate child is not sufficient evidence.
- Return a bounded envelope with status, revision, runtime version, elapsed
  time, exit code if known, validated output on success and structured
  validation/cleanup errors on failure. Never include secret values or raw
  environment dumps. Sanitization is not a guarantee against malicious output;
  review display/retention and artifact references separately.
- Reuse existing tool progress and result events; do not introduce a parallel
  event database or claim rollback of file/network side effects.

### Inert artifact-capture increment (2026-10-29)

The internal `SkillExecutionArtifact` captures manifest, instructions and declared
binary/text files into bounded private memory, derives a framed content revision,
and returns defensive byte copies/frozen metadata. It shares the canonical bounded
file-read operation with text resources, preserving their UTF-8/binary checks.
The 4 MiB capture limit includes metadata; at most 64 declared files plus automatic
manifest/instructions are retained. The capture rereads bytes and rechecks root
identity to detect observed changes; it is not an atomic filesystem snapshot,
ancestor-path attestation or defense against hostile same-user path races.

This helper is not wired into discovery, a proposal, a trust decision or a runner.
It chooses no staging layout and creates no child process. The boundary-review
gate remains in force: private run staging/protection, capture retention and
disposal, verified workspace identity, policy/consent integration and cleanup
must be reviewed and implemented before executable staging or launch. Calling
an internal capture helper is not approval of those outstanding decisions.

## Reuse and alternatives

Reuse the skill repo/Markdown loader, tool capability registry, safety policy,
approval lifecycle and progress/result plumbing. Keep a direct-argv execution
operation separate from the shell wrapper because its protocol, environment,
identity and termination guarantees differ. Do not modify terminal behavior
merely to satisfy the skill runner.

Rejected for the initial slice: shell interpolation, PATH-selected Node,
dependency installation, automatic imports during discovery, automatic retry,
a long-lived broker, a sandbox claim and a new plugin platform.

## Evidence required before acceptance and implementation

### Existing policy HTTP regression coverage

The [policy acceptance suite](../../tests/e2e/skill-execution-policy.spec.ts)
uses the existing isolated Playwright production server and synthetic workspace.
It checks mode persistence, rejected malformed policies without state changes,
server-issued receipts, unchanged-scope receipt preservation, changed/revoked
scope renewal, unapproved drafts and refusal of generic memory write/delete
bypasses. Every settings response must continue to report execution unavailable.
Run it with `npx playwright test skill-execution-policy.spec.ts --project=chromium-desktop`.
Each Playwright invocation creates a fresh database and production server;
repeating tests within one invocation does not reset the database.

These are API lifecycle regressions, not script execution, browser consent UX,
process-restart recovery or process-tree cleanup acceptance. They do not remove
the boundary-review gate or complete the requirements below.

### Remaining acceptance gates

1. Assign an accountable execution/approval owner and review the proposed
   fields, schema subset and numeric bounds against dependency-free fixtures.
2. Implement and verify the selected run-scoped snapshot lifecycle and integrate
   artifact-bound approval transitions with the existing approval endpoints,
   including denied/expired/stale/duplicate responses and restart.
   Record a focused persistence decision before changing tables/layout.
3. Prove process-tree termination on each supported platform, including
   cancellation before spawn, descendant output and timeout during cleanup.
4. Test `.mjs`/`.cjs`, paths with spaces, metacharacters as JSON data, differing
   PATH Node, runtime mismatch, symlink/source mutation, invalid/oversized
   schemas/input/output, nonzero exit and no execution during discovery.
5. Run deterministic positives 10/10 with reset state and every enumerated
   negative fixture; report the actual OS/Node matrix. No live credentials or
   providers are needed for this slice.
6. Meet the shared-bundle portability acceptance above. Record any unavailable
   host validation as outstanding; local parser or runner tests alone do not
   establish Claude Code or other-host compatibility.

W0 does not finish until these design decisions and its selected baseline
gates are reviewed. W2 workflow serialization, coordinated run/retry budgets
and durable human interaction need their own contract and persistence review;
this ADR does not choose them.
