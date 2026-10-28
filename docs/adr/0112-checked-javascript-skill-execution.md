# ADR-0112: Checked JavaScript skill execution

Status: **Proposed; implementation blocked on boundary review**

Date: 2026-10-28

Related work: [W0 / 3.1.0](https://github.com/CircuitWall/jarela/issues/826),
[W1 / 3.2.0](https://github.com/CircuitWall/jarela/issues/827),
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

### Bundle and protocol

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

### Identity, authority and lifecycle

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

1. Assign an accountable execution/approval owner and review the proposed
   fields, schema subset and numeric bounds against dependency-free fixtures.
2. Resolve snapshot persistence/immutability and artifact-bound approval
   transitions, including denied/expired/stale/duplicate responses and restart.
   Record a focused persistence decision before changing tables/layout.
3. Prove process-tree termination on each supported platform, including
   cancellation before spawn, descendant output and timeout during cleanup.
4. Test `.mjs`/`.cjs`, paths with spaces, metacharacters as JSON data, differing
   PATH Node, runtime mismatch, symlink/source mutation, invalid/oversized
   schemas/input/output, nonzero exit and no execution during discovery.
5. Run deterministic positives 10/10 with reset state and every enumerated
   negative fixture; report the actual OS/Node matrix. No live credentials or
   providers are needed for this slice.

W0 does not finish until these design decisions and its selected baseline
gates are reviewed. W2 workflow serialization, coordinated run/retry budgets
and durable human interaction need their own contract and persistence review;
this ADR does not choose them.
