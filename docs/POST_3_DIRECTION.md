# Post-3.0 product direction: dependable core, user-owned extensions

Status: **Planned; W0 started, no capability release gate complete**

Date: 2026-10-27

Last document review: 2026-10-28

Decision record: [ADR-0111](adr/0111-dependable-core-user-owned-extensions.md)

This PRD defines planned priorities for work after Jarela 3.0.0. On 2026-10-28
the product direction was accepted for planning. The initial six-release plan
was consolidated into three related minor upgrades, 3.1.0 through 3.3.0:
foundations (W0-W2), authoring/contribution (W3-W4), and advertisements (W5).
These are evidence-gated release
targets, not release announcements, dates or claims about existing implementation.
Implementation contracts still require their focused design reviews.

### Reading and delivery scope

- Sections 1-4 define the product boundary and evidence.
- R1-R6 are cross-cutting constraints; R7-R11 define candidate capabilities.
- Section 5A turns those capabilities into user journeys and acceptance cases.
- Section 6 defines sequencing and gates, not a commitment to ship everything
  together. Section 9 records unresolved design decisions and review findings.

The first runtime capability slice, part of the 3.1.0 foundations milestone
after its W0 baseline and contract work, is **one JavaScript-backed skill with checked
input/output and a visible result**. File workflows, interactive forms,
agent-assisted authoring and contribution build on independently tested slices.
Agent advertisement work can proceed independently. Optional sharing and richer
upgrade reports are not prerequisites for this first slice.

## 1. Product thesis

**Jarela maintains the workspace; users and their connected agents extend what
happens inside it.**

Jarela should be a dependable local-first environment for configuring agents,
connecting context, executing and delegating work, observing and steering it,
retaining useful context, and checking completion. Its next phase should improve
the quality and coherence of that loop rather than continually expanding the
built-in feature catalog.

When a user needs a specialized capability, the preferred response is an existing
tool, skill, workflow, MCP connection, or extension. An agent may help discover,
author, test, and maintain that extension within the user's authorization.
Neither installation nor agent authorship makes code trustworthy.

### Code-first skills and workflows

If a step can be done by code, it must be done by code. This governs execution,
not just validation: reuse authorized typed tools or existing implementations
before adding scripts for specified calculations, transformations, branching,
iteration and checks. Model steps handle intent, ambiguity, judgment and
explanation; validate their machine-checkable output properties before passing
them downstream. Every code step needs explicit input, output and executable
validation. Missing execution support or authorization is an explicit blocker,
not permission to bypass policy or simulate successful execution in prose.
This direction does not mean the proposed checked runner is already installed.

This is a product hypothesis: the core is broad enough to support representative
workflows, and remaining gaps can often be solved outside it. Repository history
establishes introduced capabilities, not proven usability, reliability, demand,
or feature completeness. The validation program below must test that hypothesis.

## 2. Evidence boundary

This is a scoped direction proposal, not a full release-documentation or
security audit. The grounding snapshot is
`c0851d6cacae380edd01d93f35ee4b93f3455935`, the recorded 3.0.0 bump, following the
existing documentation baseline
`50f0be5ce99917e2f580ad74716cc4169be14e71`. It does not advance that baseline or
independently verify publication.

| Observed foundation | Evidence | What it does not establish |
| --- | --- | --- |
| Local-first orchestration, SQLite state, registry and adapter boundaries | [Architecture](ARCHITECTURE.md), [snapshot README](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/README.md) | That all workflows succeed or that every feature belongs in core |
| Provider/tool plugins, MCP, harnesses and integration recipes | [Extension guide](EXTENDING.md), [ADR-0013](adr/0013-external-extension-contract.md) | A uniform lifecycle or sandbox for every extension type |
| Package install, pending approval for non-allowlisted packages, and removal | [Installer](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/tools/packages/package-install.ts), [allowlist](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/tools/packages/package-allowlist.ts), [installer tests](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/tools/packages/package-install.test.ts) | That every install needs a fresh approval, that publishers are verified, or that package code is safe |
| External tool schema/config/secret descriptors and load errors | [External loader](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/tools/runtime/external.ts), [shared plugin loader](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/utils/cjs-plugin-loader.ts) | That import-time code is isolated or its declared effects are enforced |
| Package manifests carry tool metadata and participate in registry loading | [Package loader](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/tools/packages/langchain-packages.ts), [registry](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/tools/runtime/registry.ts) | That read/write/execute labels constrain arbitrary Node code |
| Agents can read and write skills when a writable repository is configured | [Skill tools](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/tools/system/skills.ts), [tests](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/tools/system/skills.test.ts) | That every edit requires a proposal or is semantically correct |
| Skills are discovered as Markdown, with optional JSON fixtures for read-classified checking tools | [Skill loader](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/skills/index.ts), [fixture runner](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/skills/fixtures.ts) | An executable skill-bundle contract; fixture capability checks do not isolate arbitrary host code |
| One-shot and persistent terminal execution already exist | [local_exec](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/tools/general/exec.ts), [terminal](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/tools/general/terminal.ts) | Installed Python/TypeScript runtimes, a skill runner, or safe arbitrary scripts |
| Workflow progress requires input/output/validation fields and evidence for done items; retry logic is bounded | [Progress tool](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/tools/general/workflow-progress.ts), [retry enforcement](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/agents/workflow-step-retry.ts) | A file-defined workflow executor, deterministic proof from evidence text, or automatic safe replay of side effects |
| Approved configuration actions have an existing application path | [Proposal application](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/agents/proposals.ts) | A generic typed question/choice form, or identical approval behavior for every extension path |
| Available delegates already appear in the system prompt; delegation checks the caller's roster, ancestry and depth | [Prompt assembly](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/agents/prepare/system-prompt.ts), [delegation](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/tools/delegation/delegate.ts) | A dedicated editable "call me when" contract or reliable semantic task matching |
| A breaking runtime upgrade defines the 3.0 major boundary | [3.0 changelog](CHANGELOG.md#300-2026-10-27), [package engines](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/package.json) | A new extension sandbox, a data migration, or a new architecture |

3.0 drops Node 22 support and requires Node 24.15.0+ on 24.x or Node 26+.
Node 25 is unsupported. Source/npm users must upgrade before installing 3.0;
bundled installers include Node 24. Future compatibility work must treat runtime
requirements separately from tool schemas and stored data.

## 3. Users and desired outcomes

| Actor | Need | Desired outcome |
| --- | --- | --- |
| Everyday operator | Accomplish a task without understanding Jarela internals | A clear result, visible approvals and understandable recovery |
| Advanced user or extension author | Add a domain capability without maintaining a core fork | A documented supported surface with repeatable validation |
| Connected agent acting for a user | Translate a concrete request into a bounded extension change | An inspectable proposal, authorized execution and evidence of the result |
| Core maintainer | Keep the platform reliable without owning every integration | A consistent scope filter and explicit maintenance ownership |

## 4. Scope and ownership

| Core responsibility | User/extension responsibility |
| --- | --- |
| Run lifecycle, cancellation, recovery, persistence and data integrity | Domain-specific services, queries and business rules |
| Permission decisions, credential handling, approval UX and truthful trust warnings | Declaring needed access and documenting external service setup |
| Supported extension contracts, discovery and useful diagnostics | Implementing and maintaining extensions against those contracts |
| Agent configuration, delegation, recall and workflow primitives | Personal agent profiles, skills, schedules and task procedures |
| Installation/upgrade guidance and compatibility reporting | Choosing sources, versions, accounts and whether to accept a change |
| A small, justified set of supported built-ins | Optional niche connectors and organization-specific adaptations |

Existing supported integrations remain supported under their documented
contracts. This proposal does not remove tools, change permissions, or transfer
maintenance obligations retroactively. A later deprecation needs a separate
decision, migration path and release communication.

### Admission rule for future work

> If a change solves a particular user's task, prefer an extension. If it makes
> the shared workspace safer, more dependable or easier to extend, consider core.

Every feature proposal should record:

1. The user task and evidence of friction, not only a possible capability.
2. Why existing configuration, skills, workflows or extension surfaces are
   insufficient.
3. The narrowest suitable placement and the owner who will maintain it.
4. Permission/data consequences, validation evidence and recovery behavior.
5. Any additional core surface, dependencies and long-term compatibility cost.

A core feature may still be justified when the existing boundary cannot express
the task, the requirement spans materially different workflows, or a maintained
default is necessary for first-run usefulness. Prefer a reusable primitive over
embedding one service's business logic. Exceptions require a written rationale;
popularity alone is not a safety or maintenance argument.

## 5. Requirements

These are target outcomes. First test the current implementation; fix demonstrated
gaps rather than creating a parallel extension framework.

### R1. Extension-first task routing

- **Input:** A user goal, current agent permissions and configured capabilities.
- **Output:** Use an existing capability, propose an extension/configuration
  change, or explain a concrete unsupported boundary.
- **Validation:** Representative scenarios show discovery before unnecessary
  authoring. No core source edit is required for the selected supported extension
  path. A task needing core changes is explicitly escalated, not worked around.

### R2. Inspectable, bounded agent assistance

- **Input:** A scoped user request and an identified extension surface.
- **Output:** Before new executable code is installed, imported or run, show its
  source/version or local artifact identity, purpose, changed files, access needs,
  expected side effects, test plan and disable/recovery instructions.
- **Validation:** Test accept, deny, cancel and changed-artifact cases. Approval
  or a previously configured explicit trust policy must cover the actual artifact
  and scope; a changed artifact or expanded access requires a new decision.
  An agent must not grant itself broader trust, change the approval policy to
  complete its task, or publish externally without separate authorization.

Skill/config changes should show the applicable diff and follow their existing
authorization policy. Do not silently impose a new approval on every existing
skill edit. Any policy change needs separate implementation and migration review.

### R3. Truthful trust and permission boundaries

- **Input:** A proposed extension and the selected execution path.
- **Output:** Distinguish application-level tool permissions from host-code
  privileges, and distinguish installation approval from later tool enablement.
- **Validation:** UI/docs tests must not describe in-process plugins or installed
  packages as sandboxed. Code loading, constructors, package install hooks and
  subprocesses must be considered before execution, not just tool invocation.
  Unapproved artifacts are not imported for "inspection."

Existing publisher-prefix allowlisting is policy, not proof of package
authenticity or safety. A read capability does not stop imported code from
writing files or accessing the network. A prompt/skill is not an enforcement
boundary. Broader execution authority must be disclosed, not hidden behind a
least-privilege badge.

### R4. Observable lifecycle and recoverable failure

- **Input:** An install, update, reload, credential failure, disable or removal.
- **Output:** Explicit status, actionable sanitized errors, affected agents/tools
  and documented recovery steps.
- **Validation:** Inject malformed exports, missing credentials, unavailable
  dependencies, failed installation and incompatible updates. Unaffected work
  remains usable where the architecture permits. Failed updates must not report
  success; restoration of a previous version must be tested where offered.
  When rollback cannot reverse an external action, state that explicitly.

Disabling prevents future use through the relevant Jarela path; it is not a
claim to undo already executed code, revoke copied credentials or cancel remote
side effects. Define in-flight behavior for each extension type before changing it.

### R5. Compatibility without core forks

- **Input:** The supported Jarela/Node versions, extension contract and fixtures.
- **Output:** A reproducible compatibility result with migration guidance for
  breaking changes.
- **Validation:** Test the documented public surfaces, invalid schemas,
  collisions and load failures. At an upgrade gate, exercise both the previous
  supported app version and the candidate with the same extension fixture.
  Record actual tested versions; do not infer support from a semver range.

Do not invent a universal manifest or contract versioning scheme before a
demonstrated incompatibility requires it. Reuse existing contracts, and keep
workspace-package versions independent from the app.
This does not prohibit an explicit schema version for the new file-workflow
format in R8: that narrow format needs detectable compatibility from its first
release, without replacing existing extension contracts.

### R6. Private, evidence-based completion

- **Input:** A workflow with explicit inputs, expected output and validation.
- **Output:** Checked results or a visible incomplete/failed status with evidence.
- **Validation:** Distinguish successful tool execution from completion of the
  user's goal. Test missing inputs, denied access, timeouts and provider outages.
  Keep credentials in the existing encrypted stores, never generated source or
  shared reports. Use synthetic fixtures; real accounts require explicit consent.
  No new analytics, telemetry or mandatory cloud service is introduced.

### R7. Script-backed skills

A skill should be able to bundle instructions, reference material, fixtures and
explicit executable entry points. **JavaScript is the default and initial
supported script language**, using the same supported Node executable that runs
Jarela. The initial slice requires no additional interpreter, transpiler or
package installation. Direct TypeScript, Python and shell-specific entry points
are deferred; they are not prerequisites for delivering script-backed skills.

- **Input:** A skill bundle, declared entry point, typed arguments, workspace,
  required interpreter/version, dependency declaration and execution authority.
- **Output:** A bounded result envelope: status, exit code when applicable,
  validated structured output or artifact references, sanitized diagnostics,
  elapsed time and validation evidence.
- **Validation:** Test a dependency-free JavaScript entry point using Node
  built-ins, including when a different `node` is on PATH. Cover incompatible
  runtime requirements, unsupported entry-point languages, nonzero exit, invalid
  output, timeout, cancellation, argument quoting, spaces in paths, changed
  scripts after approval and excessive output.

Requirements:

- Keep existing prompt-only skills working without migration or implicit
  execution. Discovering or reading a skill must never execute its scripts.
- Reuse existing execution/safety paths where their lifecycle fits; do not
  introduce an independent shell/permission implementation. A validator script
  is executable code and requires the same authorization as other scripts.
- Use explicit arguments and structured data bindings, not raw user/model text
  interpolated into shell commands. Define working-directory, path/symlink,
  environment, timeout, output-limit and child-process cleanup behavior.
  Path containment does not imply host isolation.
- Resolve the Node executable from the running app (`process.execPath`), not
  an arbitrary `node` on PATH. Define and test supported module formats and
  entry-point extensions in W0; do not rely on ambient package/module resolution
  or expose Jarela's internal dependencies as a skill API.
- Validate any declared Node version requirement against the actual runtime.
  Reject unsupported entry-point languages explicitly rather than guessing an
  interpreter. Later language support needs a documented execution strategy and
  fixtures; TypeScript authors can supply precompiled JavaScript in the initial
  slice, but compilation is outside the runner's initial contract.
  Dependency installation, network access and package hooks need their own
  disclosed authority; JavaScript support does not authorize them automatically.
- Keep secrets out of bundle files and result envelopes; use existing typed
  credential channels. Report missing credentials explicitly.
- Bind authorization and results to a stable bundle revision covering entry
  points, referenced scripts, validators and executable dependencies, not just
  the top-level file name. Define how mutable files are staged or checked so a
  post-review change cannot silently execute under the old approval.
  An identity/hash establishes which artifact ran, not whether it is safe.

### R8. File-defined, interactive verified workflows

A reusable file should describe how to combine instructions/model steps,
registered tool calls, script-backed steps, validation, bounded retries and
human input. It should be reviewable and versionable alongside a skill, not
exist only in a chat transcript.

- **Input:** A workflow definition, validated invocation inputs and authorized
  tool/runtime configuration.
- **Output:** A run with explicit step states, checked data bindings, artifact
  references, bounded attempts and actionable waiting/failure/completion status.
- **Validation:** Execute a mixed workflow with a script, a tool, a failed output
  check, an allowed retry and a user choice. Assert exact outputs and states.
  Re-run the same deterministic fixture without a model; test agent-assisted
  steps separately without presenting model output as deterministic.

Minimum contract to design and test:

| Building block | Input | Output | Validation |
| --- | --- | --- | --- |
| Definition loader | File and declared format/schema version | Parsed, inert plan or explicit errors | Reject malformed/unknown fields, duplicate step IDs, missing references, unsafe paths and unsupported versions before execution |
| Step and bindings | Validated upstream data plus declared operation | Named output or artifact | Validate each output before downstream consumption; no unchecked model-authored values or arbitrary expression evaluation |
| Validator | Expected schema/assertions and observed result | Pass/fail with specific evidence | Invalid JSON, absent artifacts and failed assertions block progress even when a command exits zero |
| Retry policy | Retryable failure, attempt/time budget and replay classification | Bounded retry, stop or request for user decision | Never retry denied access, waiting-for-user or cancellation; uncertain external writes require reconciliation or a new decision |
| Question/choice step | Typed form, stable field/option IDs and owning run/step | Validated response, cancellation or explicit waiting state | Cover required text, single/multiple choice, invalid/stale/duplicate responses, cancellation and reconnection |
| Run lifecycle | Definition identity, checked step results and interaction state | Inspectable active/waiting/failed/cancelled/completed state | Preserve the definition identity; changed definitions cannot silently resume old runs; no false completion |

Additional constraints:

- For the initial slice, prefer a bounded acyclic sequence/dependency graph.
  Reject cycles and unbounded loops; do not begin with a general programming
  language. Select one serialization format/schema in the implementation
  proposal; neither YAML nor JSON is committed by this PRD.
- Keep schema validation, deterministic assertions and model judgment distinct.
  A populated `validation_evidence` string is not proof that its assertion ran.
  Define how executable checks produce evidence the runtime can verify.
- Reuse current workflow progress and retry behavior where compatible. The
  existing contract-retry nudges are not a file runner; avoid nested retry
  multiplication. One coordinator must enforce total step and run budgets.
- Retry writes only with an explicit idempotency/reconciliation contract.
  A timeout does not establish that a remote operation failed. Preserve prior
  successful outputs; invalidate downstream outputs when their inputs change.
- A user answer is data, not code or permission to execute. Keep choice forms
  separate from security approvals. Never infer consent from a default, timeout
  or a model answering its own question. Secret entry uses credential UI.
- Provide accessible keyboard-operable forms in the desktop UI. For channels
  without forms, use a validated text fallback or show a resumable request to
  open Jarela; never silently skip the step.
- Bind responses to the correct user/session, run, step, definition and request.
  Define atomic transitions, duplicate-response handling, restart recovery,
  cancellation and expiry. Waiting must not spin an agent/retry loop.
  Durable interaction/run-state changes require a dedicated persistence ADR.
- Keep run status and outcome separate. All required steps and checks must pass
  before reporting verified success; skipped optional steps and unresolved
  uncertainty remain visible. Cancellation, budget exhaustion and partial
  external effects produce explicit non-success outcomes.

### R9. Workflow-driven extension development

Ship a reusable extension-development procedure built on R7/R8, rather than a
second agent runtime. "Self-development" means an agent helping fill a concrete,
authorized capability gap; it does not mean rewriting its own trust boundaries.

- **Input:** A user goal or an agent-discovered gap within an already authorized
  task, evidence that existing capabilities are insufficient, and an approved
  workspace/extension target.
- **Output:** A reviewable extension artifact, tests, setup/permission notes,
  compatibility results, ownership and recovery instructions; installation and
  enablement only when separately authorized.
- **Validation:** Develop one minimal extension against a synthetic service
  without core patches. Deny installation and verify it is not loaded. Approve
  the reviewed artifact, verify a known result, inject an update failure, and
  exercise disable/removal and any claimed restoration.

Required stages:

1. Discover configured tools, documented public contracts and existing packages;
   decide reuse, configuration or authoring.
2. Ask for unresolved scope/account/access choices. Choose the narrowest
   supported surface and declare inputs, outputs, validation and side effects.
3. Generate in an inert staging workspace outside auto-loaded plugin directories.
   Record source/version or artifact identity; do not run generated imports,
   install hooks or tests before the relevant code-execution authorization.
4. Perform static checks, then authorized deterministic fixture tests with
   synthetic credentials/data. Real service probes need explicit scope and
   authority; never treat an OAuth redirect as proof of resource access.
5. Present the diff, privileges, dependency/runtime needs and evidence. Changes
   after review invalidate approval for the changed artifact/scope.
6. Install/enable through existing supported lifecycle paths, verify the actual
   capability, and save user-owned source, support expectations and recovery
   notes. A failed stage stops downstream activation.

The workflow must not extend package allowlists, enable unsafe execution,
increase permissions, edit core internals, publish code or repeatedly rewrite
itself merely to get a passing result. Escalate those needs to the operator.
Improve the reusable procedure only as a scoped, reviewable change.

### R10. Contribution as an explicit, optional workflow

Separate "this extension works for me" from "send it upstream." Contribution is
an opt-in procedure that can target a user-selected extension repository or
Jarela itself, not an automatic consequence of successful generation.

- **Input:** A selected artifact/change, destination, publication scope and
  explicit user authorization.
- **Output:** A sanitized contribution bundle or, when authorized, a topic-branch
  commit and draft PR with problem statement, ownership, compatibility and test
  evidence.
- **Validation:** A local-only fixture produces a reviewable bundle with no
  network write. Test denial and cancellation at publication gates, mixed/dirty
  worktrees, failing tests, sensitive fixture content and unavailable credentials.
  A live draft-PR test requires a separately approved test repository.

Required stages: classify core versus extension using the admission rule;
check destination contribution/license rules and reuse; inspect branch/worktree;
make a focused change; validate and sanitize code/docs/fixtures; present the
exact outgoing diff and destination; request authorization for remote writes;
then report actual branch/PR status and review feedback.

Never include credentials, user memory, raw chats or private service data.
Do not assume permission to publish employer-owned or third-party code.
Existing trust in local execution does not authorize pushing or opening PRs.
No automatic main-branch push, merge, package publication or bypass of checks.
Follow the destination's conventions, including Jarela's Conventional Commits
and rebase-merge policy when contributing here. If publication is unavailable
or denied, keep the local bundle and report that no contribution was sent.

### R11. "Call me when": discoverable agent specialization

Agents should advertise when they are useful to an authorized active agent,
similarly to how a tool description helps selection, **without becoming a
separate registered/model-bound tool for each agent**. The active agent remains
the coordinator and uses the existing delegation mechanism when the task fits.
This is capability-based task handoff, not an event subscription or passive
monitoring of conversations.

- **Input:** A specialization advertisement derived on agent-config save from
  saved instructions and the resolved permission map, the caller's
  allowed delegate roster and invocation permission, and the current task.
- **Output:** A bounded authorized-delegate catalog in the caller's system
  prompt, followed by either direct work, a justified delegation, or a request
  for clarification. A handoff carries a concrete task, necessary context,
  expected output and validation criteria.
- **Validation:** Assemble prompts for permitted and denied callers; verify
  catalog membership matches actual delegation authority. Exercise matching,
  nonmatching and ambiguous tasks separately from deterministic permission
  checks. A listed specialty must never override a runtime refusal.

The advertisement contract should include:

- Stable agent ID, display name and concise purpose.
- **Call me when:** concrete task conditions and examples of useful handoffs.
- **Do not call me for:** exclusions and limits that avoid broad, overlapping
  claims such as "delegate every task to me."
- Expected inputs and output/result shape. Descriptions express intended
  specialization, not proof of expertise, access or successful validation.

#### Generate on config save

The default authoring path should be **save config -> derive advertisement ->
validate -> expose to authorized callers**, not another mandatory text field.
Use instructions to describe intended specialization and the permission map to
constrain capability claims. Never infer expertise solely from an enabled tool.

- **Trigger:** After a successful save, compute a fingerprint of routing-relevant
  inputs: identity/instructions, resolved target tool permissions and bounded
  public tool descriptions, plus the generator contract version. A materially
  changed fingerprint schedules generation; an unchanged save does not incur
  another model call. Cover UI/API creation, updates, duplication and approved
  agent configuration actions through a shared post-save path, not a UI-only
  callback. Do not perform network/model calls inside the config-store write.
  Include generation-policy/model selection in job identity and invalidate
  in-flight work when that policy changes. Do not fingerprint credentials or
  generate a fresh job solely because transient readiness changed.
- **Source:** Use the committed configuration, not unsaved form state. Resolve
  permissions using the same canonical logic as execution, including permitted
  proxy-reachable tools rather than only pinned tools. Separate authorized
  capability from temporary readiness failures such as missing credentials;
  neither is proof of external account/resource authorization.
- **Generation:** Produce a bounded structured description using only a
  user-configured provider/model under an explicit generation setting with
  disclosed egress and usage cost. Instructions may contain private information:
  send only the necessary text under that setting, never credentials, raw tool
  results, private conversations or unrelated memory. The generated advertisement
  must not reproduce private instructions or account identifiers. The source
  text is data, not authority to change the generator's rules.
- **Save semantics:** Persist configuration first and run generation separately
  through existing in-process scheduling/queue patterns. Expose pending, ready,
  failed, stale and disabled states. Missing model access or generation failure
  does not roll back a valid config save; report the separate failure clearly.
  Do not silently substitute an unconfigured provider or enable model access.
- **Validation and publication:** Schema/length-check results and reject explicit
  tool/capability references outside the resolved permission snapshot. Semantic
  claims remain best-effort, not a proof of ability. Publish only if the agent
  still exists and the source fingerprint still matches. Coalesce rapid saves;
  late results cannot overwrite a newer revision or resurrect a deleted agent.
- **Freshness:** Invalidate a derived advertisement immediately when its sources
  change, rather than advertising the old capability while generation runs.
  Permission-map changes outside config save (global tool policy, package/MCP
  changes and relevant tool metadata changes) also invalidate it. Refresh under
  the configured policy; avoid probing services or making a model call on every
  prompt assembly. Dispatch always rechecks current authority and readiness.
- **Operator control:** Show the generated description and its freshness/status,
  allow explicit regeneration and disabling, and define an optional reviewed
  override if needed. An override has provenance and is revalidated against
  permission changes; it cannot grant capabilities. Existing delegation remains
  usable when generation is disabled/unavailable, but omit stale generated
  claims and visibly distinguish legacy catalog data from generated metadata.

Persisting fingerprints, generation state or overrides needs a focused storage
ADR before implementation. Define the configured generator/model selection and
cost limits there; saving cosmetic settings must not generate unnecessary calls.
The eventual generation prompt is a registered standalone prompt, with schema
and adversarial-input tests plus assembled-output verification. This PRD adds
no generation prompt or model calls itself.

Requirements:

1. Reuse the existing available-delegates prompt section, roster checks and
   `delegate_to_agent` path. Do not generate per-agent tool schemas, introduce a
   new broker or automatically call all advertised agents.
2. Keep advertisement and authorization separate. Only targets the caller may
   invoke are advertised; no hidden-agent identity or description is disclosed.
   Recheck authority at dispatch, including when a roster changes after prompt
   assembly. Missing/removed targets produce actionable failures.
3. Keep delegation opt-in. Existing agents without the new metadata continue
   using existing delegation behavior; no migration silently grants a roster
   entry, enables a tool or changes a target's privileges.
4. Treat advertisements as bounded descriptive data, not privileged prompt
   instructions. Validate length/shape, delimit them consistently and do not
   inject another agent's private instructions, credentials or conversation.
   Agents may propose edits; config-save generation does not broaden routing
   authority or automatically rewrite the source agent's instructions.
5. Match by meaningful specialization and task need, not merely keyword overlap.
   The caller may handle work itself. Do not force delegation for trivial tasks
   or invent a confidence score. When overlap materially affects the outcome,
   ask for clarification or use a transparent bounded choice.
6. Preserve target-side permissions and approvals; routing is not escalation
   and does not union the caller's and target's tool permissions. It can provide
   access to a deliberately authorized specialist, so disclose expected side
   effects and share only task-needed context. Sensitive data transfer and
   external actions must remain within the user's authorized scope.
7. Preserve depth and cycle guards. Define per-task call/time/cost budgets and
   prevent sequential ping-pong or fan-out that depth limits alone do not catch.
   Refusal, cancellation and uncertain side effects must not cause blind rerouting
   to another agent to evade a gate.
8. Keep the parent accountable for the final response: announce the handoff,
   expose target/task/status/result provenance, and check the returned output.
   A successful delegate call is not proof the user's task is complete.
9. Keep prompt size bounded and ordering deterministic. Define overflow behavior
   before implementation; do not silently hide authorized targets or introduce
   an unbounded prompt catalog. Preserve cache boundaries and inspect every
   affected assembled prompt variant using the prompt-verification procedure.

Acceptance fixtures must cover: no delegates; one relevant target; unrelated
tasks handled without delegation; overlapping specialties; absent metadata;
malformed/hostile advertisements; denied or revoked targets; changed
advertisements; self/cyclic delegation; repeated handoffs; missing required
inputs; target errors/timeouts and invalid returned output. Assert no per-agent
tool is added. Generation tests must also cover no-op saves, rapid concurrent
saves, failed saves, late results, deletion, disabled/unavailable generation,
invalid or leaking output, external permission changes and stale overrides.
Assert no unconfigured model call and no stale capability publication.
Prompt/permission tests establish structural correctness;
authorized live multi-provider evaluations must separately report observed
selection quality and unnecessary delegation, not claim guaranteed routing.

This is a shared agent-coordination improvement, independent of executable
skills and file workflows. Such workflows may later select authorized delegates
through the same path; they must not invent a second permission model.

## 5A. User journeys and reusable capability lifecycle

These journeys elaborate R1-R11 rather than introduce seven new subsystems.
All UI labels below are proposed, not existing controls. Each journey begins
with explicit user intent or previously granted task authority. No successful
task automatically creates, activates or publishes a new capability.

### J1. "Make this reusable"

**Scenario:** After generating a useful report, the user asks to turn the work
into a reusable procedure.

- **Input:** A selected completed task, checked outputs/evidence, user-selected
  relevant steps and a destination in the writable skill/workflow repository.
- **Output:** An inert draft with parameters, instructions, optional JS assets,
  questions, permission/runtime requirements and representative fixtures.
- **Validation:** Run a second synthetic input with different values and assert
  the expected result; the original task's literal values must not be required.

Flow:

1. Select the useful procedure and corrections, not the entire chat transcript.
   Display what source material will be used before any configured model call.
2. Identify variable inputs, fixed assumptions, account/resource choices and
   decisions requiring human judgment. Unknowns become explicit questions or
   blocked prerequisites, not invented defaults.
3. Use JS for deterministic transformations/checks and model steps only where
   interpretation is needed. A prompt-only skill is sufficient when execution
   adds no value; do not generate code merely to fill a template.
4. Preview the draft diff. Remove secrets, personal task data, machine-specific
   paths and copied content without publication rights. Flag unresolved values.
5. Test under the applicable execution authority, then let the user save the
   draft or enable it. Editing, saving, running and publishing are distinct.

Acceptance cases: unsuccessful source task cannot be labeled a verified recipe;
private values are replaced with explicit inputs; collision with an existing
skill requires a reviewed update or a new ID; denied execution still permits
an inert draft; failed tests prevent a "verified" label. Include an authorized
second-author walkthrough without undocumented setup.

**Placement:** R7-R9; later composition, not a prerequisite for W1.

### J2. Inspect, test, then run

**Scenario:** A user opens a file-defined workflow and wants to understand what
it will do before executing it.

- **Input:** A specific definition/bundle revision and optional invocation inputs.
- **Output:** A plan showing dependency order, missing inputs, operation types,
  required authority, questions, checks and configured attempt/time/cost limits.
- **Validation:** Inspecting malformed or hostile definitions produces errors
  without loading executable modules, running scripts or probing services.

Keep three actions distinct:

| Action | Allowed behavior | Must not imply |
| --- | --- | --- |
| Validate definition | Parse inert metadata and validate references/contracts | That code is safe or a real service is reachable |
| Test fixtures | Run authorized checks against explicit mocks/local fixtures | That arbitrary imported code is isolated, or production writes cannot occur without enforced isolation |
| Run | Execute the approved revision with real configured inputs and effects | That preview/test approval automatically grants production access |

Show deterministic versus model/agent steps, script/tool/delegate identity,
data passed between steps, external effects and the configured retry policy.
If a value or cost cannot be known until execution, label it unknown; never
present speculative exact costs or script side effects as verified.

A simulation must use explicit fixture adapters and identify unsupported steps.
Do not offer a generic "dry run" that invokes real writes. Initial delivery may
show a simple step list; a graphical editor is not required.

Acceptance cases: missing credentials and inputs; unsupported JS entry point;
invalid binding; cycle; unknown operation; changed artifact between preview
and run; denied test; test with no network-write authority. Instrument fixture
adapters to assert actual calls, not just displayed badges.

**Placement:** R7/R8, W1/W2. Definition inspection is part of the foundational
slice; a richer workbench follows demonstrated usability needs.

### J3. Diagnose a capability gap before building

**Scenario:** An agent cannot finish a requested task and proposes a next step.

- **Input:** Task context, bounded sanitized failure evidence, configured
  capabilities and current authority/readiness.
- **Output:** A classified blocker with evidence, uncertainty, least-change
  remedy and an optional extension-development proposal.
- **Validation:** Synthetic blockers route to the correct remedy; denial never
  initiates alternate code generation or another-agent permission bypass.

| Blocker | Preferred response |
| --- | --- |
| Missing input or ambiguous scope | Ask a bounded question |
| Denied permission | Explain the boundary; only request a legitimate operator decision |
| Missing credential/account setup | Use existing setup; never request secrets in a workflow text field |
| Unavailable runtime/dependency | Explain prerequisites and seek separate setup authority |
| Transient outage/rate limit | Report or use a bounded, appropriate retry |
| Incompatible existing extension | Diagnose/update the owned artifact with review; preserve restoration evidence |
| Genuinely absent capability | Propose reuse or authoring through R9 |
| Unknown cause | Preserve unknown status and collect bounded diagnostic evidence |

Do not turn every tool failure into an extension task. The proposal records
why existing tools/skills/delegates are insufficient and who would maintain
the result. User rejection ends this branch without recurring unsolicited
proposals on the same unchanged task.

**Placement:** R1/R4/R9; a reusable procedure using current tools first.

### J4. "Why this agent?" routing inspection

**Scenario:** An operator saves a specialist configuration and tests how it
would be advertised and selected.

- **Input:** Generated advertisement/source revision, caller identity/roster
  and synthetic sample tasks.
- **Output:** Eligibility reasons, exact bounded advertisement visible to that
  caller, generation freshness and optional model selection evaluation.
- **Validation:** Denied targets remain undisclosed; stale generated claims are
  omitted; a selection test does not execute the chosen delegate.

Separate deterministic eligibility from model judgment and actual handoff
results. A model explanation is not proof of its internal reasoning or target
competence. Test positive, negative and overlapping task examples, recording
chosen target or no-delegation, expected target set and unnecessary handoffs.
Ambiguous tasks may legitimately ask a question or stay with the caller.

Static inspection is local and inert. Model-based evaluation uses the explicit
configured generation/evaluation policy, with cost/egress disclosure and a
bounded case set. Save-time generation must not automatically run this suite
or dispatch test tasks to agents with real write capabilities.

**Placement:** R11/W5; no routing leaderboard or automatic permission tuning.

### J5. Completion receipts

**Scenario:** A substantial workflow or delegation ends, and the user wants to
know what was actually checked.

- **Input:** Existing run/step/tool/delegation events and actual validator results.
- **Output:** A compact receipt linked to the run, with task/revision identity,
  output references, checks/results, observed external effects, skipped work,
  unresolved uncertainty and usage where available.
- **Validation:** A zero-exit script with invalid output and a delegate claiming
  success without checked artifacts both produce a non-verified outcome.

Receipts are a projection of existing evidence, not a second event store or an
LLM-authored source of truth. They distinguish deterministic checks, model
assessment and operator acknowledgment. An unavailable check or usage figure
is unknown, not zero or passed. Link to evidence without exposing credentials
or unrelated private context; exporting a receipt requires a sanitized preview.
Receipts do not mean every external effect is reversible or delivery is confirmed.

Acceptance cases: completed, failed, cancelled, skipped optional steps, partial
external write, missing evidence, missing artifact and interrupted delegate.
Retention/deletion follows existing stores; new durable fields require an ADR.

**Placement:** R6/R8/R11. Begin with a concise result view, not a reporting system.

### J6. Portable capability bundles: later candidate

**Scenario:** A user wants to move a working setup to another installation or
share it without sharing their assistant's private state.

- **Input:** Explicitly selected profiles, advertisements, skills/workflows,
  source assets, dependency declarations and fixtures.
- **Output:** A reviewable local export plus an inert import plan listing
  conflicts, requirements and local credential-slot mappings.
- **Validation:** Import changes no tool permissions, installs no dependency,
  loads no executable module and calls no provider before authorization.

Exclude credential values, chat/history/memory, local paths and run data by
default. Agent identities/instructions can themselves be private: preview and
select them explicitly rather than assuming a profile is safe to share.
Map foreign agent IDs and local account slots with user review; never inherit
delegate rosters or trust policies. Missing dependencies remain unavailable,
not auto-installed. Reject archive traversal, unsafe links, oversized payloads,
unsupported formats and unresolved ID collisions before extraction/activation.
Signatures/hashes identify artifacts but are not a safety endorsement.

**Placement:** Later candidate under R5/R10; first demonstrate need through J1/W3
walkthroughs. Local export/import only, no registry or marketplace. A bundle
format and import persistence changes need separate design/ADR review.

### J7. Upgrade compatibility report: later candidate

**Scenario:** A user wants to know whether their capabilities will work after
an app/runtime update.

- **Input:** Selected extension revisions, declared requirements, previous and
  candidate app/Node versions, authorized fixtures and available adoption data.
- **Output:** Per-capability results labeled tested-pass, tested-fail,
  incompatible-prerequisite or unknown, with exact versions/checks and recovery
  guidance.
- **Validation:** No-test extensions remain unknown; successful loading alone
  does not become tested-pass. A fixture failure is shown, not hidden by a
  summary badge.

Use the existing adoption/compatibility work rather than create another release
feed. Test in isolated approved data directories with synthetic fixtures,
without upgrading the live installation or using production credentials merely
to assess compatibility. Executing old or candidate extension code still
requires appropriate authority. Do not promise rollback of irreversible data
migrations or remote effects.

**Placement:** R5, later UX over compatibility fixtures; basic compatibility
checks remain foundational even if this richer report is deferred.

## 6. Work ordering and exit gates

No phase implies a delivery date. A maintainer accepts each gate using recorded
evidence before expanding scope. Failed gates generate scoped follow-up work.

| Phase | Deliverable | Exit gate |
| --- | --- | --- |
| A. Establish the baseline | Five workflow cards and an inventory of actual lifecycle/trust behavior by extension type | Each card has input, expected output, validation, owner and observed result; unknowns remain labeled |
| B. Consolidate the core | Fixes to demonstrated reliability, recovery and confusing UX | Each reproduced failure has a regression check; existing workflows and permissions remain intact |
| C. Prove extension-first use | One existing extension configured and one minimal new extension authored through supported paths | End-to-end evidence covers discovery, authorization, validation, failed update and disable/removal without core patches |
| D. Make repetition cheap | Refined templates, docs and focused compatibility checks | A second author can repeat the fixtures from documentation without undocumented steps; reused helpers replace duplicated plumbing where appropriate |

### Planned minor upgrades

This is the bounded feature work that enables extension-first growth, not an
exception to it. R7/R8 are shared foundations; R9/R10 should primarily be reusable
skills/workflows authored on those foundations. Start with procedural prototypes
using existing tools before adding missing runtime behavior.

| Work item | Dependencies | Smallest useful delivery | Completion evidence |
| --- | --- | --- | --- |
| W0. Baseline and contract design | Phase A observations | Inventory current skill assets, execution gates, retry paths, progress state and approval/interaction UX; choose the file schema and runtime support matrix | A reviewed gap list linked to source/tests, plus separate ADRs for new persisted state or changed execution boundaries |
| W1. JavaScript-backed skill slice | W0; R2/R3 authorization design | Prompt-compatible bundle with an explicit JavaScript entry point using Jarela's Node executable, validated arguments/results and no extra runtime or dependencies | R7 positive/negative checks, PATH independence, no script execution on discovery, existing prompt-only skills unchanged |
| W2. File workflow and interaction slice | W0, W1 for script steps | Bounded ordered steps with input/output checks, one coordinated retry budget and a typed question/choice step | R8 mixed-run fixture including pause/resume, denied/cancelled response, invalid output and unsafe-retry prevention |
| W3. Extension-development workflow | W1, W2 | Discover, scaffold, authorize tests, review, install/verify and document one minimal extension | R9 end-to-end fixture and second-author walkthrough; no activation before approval |
| W4. Contribution workflow | W2; W3 only when contributing a newly developed extension | Local sanitized bundle first; explicit commit/push/draft-PR gates when authorized | R10 local-only and denial fixtures; remote publication tested separately with permission |
| W5. "Call me when" agent advertisements | Phase A routing baseline; R2/R3 authorization review; dedicated ADR for derived metadata/state | Config-save generation from saved instructions and resolved permissions, with fingerprinted freshness and operator controls; reuse existing prompt catalog/delegation, no per-agent tools | R11 generation/save-race, freshness, assembled-prompt, permission, budget and handoff fixtures; separately reported live selection evaluations |

W4 does not require W3 for an existing bug fix or independently authored
extension. Do not make all contribution work wait for an autonomous authoring
pipeline. W1/W2 need focused implementation/design reviews; a diagram or
prompt-only prototype is not delivery of an enforced runtime contract.
W5 is independent of W1-W4 and can be evaluated without waiting for a file
workflow runner. First compare the current delegate descriptions and selection
behavior against R11; implement only the demonstrated gaps.

| Planned version | Work item | Tracking | Current state |
| --- | --- | --- | --- |
| 3.1.0 | W0. Baseline and contract design | [#826](https://github.com/CircuitWall/jarela/issues/826) | Started: foundation regressions and source-linked gap inventory below; journey and design gates remain open |
| 3.1.0 | W1. JavaScript-backed skills | [#827](https://github.com/CircuitWall/jarela/issues/827) | Planned; blocked on W0 and artifact-bound execution authorization |
| 3.1.0 | W2. File workflow and interaction | [#828](https://github.com/CircuitWall/jarela/issues/828) | Planned; W1 needed only for script steps |
| 3.2.0 | W3. Extension-development workflow | [#829](https://github.com/CircuitWall/jarela/issues/829) | Planned; depends on W1/W2 |
| 3.2.0 | W4. Contribution workflow | [#830](https://github.com/CircuitWall/jarela/issues/830) | Planned; depends on W2, and W3 only for new extension authoring |
| 3.3.0 | W5. Agent advertisements | [#831](https://github.com/CircuitWall/jarela/issues/831) | Planned; routing baseline/design can proceed independently |

Related items share three GitHub milestones: 3.1.0 foundations (W0-W2),
3.2.0 authoring and contribution (W3-W4), and 3.3.0 advertisements (W5).
This consolidation supersedes the earlier one-item-per-minor mapping.
The empty 3.4.0-3.6.0 milestones are closed as superseded, not delivered.
Individual issues, dependencies and acceptance gates are preserved; each
grouped release requires every included work item's applicable gates.
Version order is the intended release sequence, not an additional technical
dependency for W4 or W5. Owners remain unassigned in the tracking issues; that
blocks acceptance of the affected release gate.

Planning does not bump the app/package manifests, tag releases or change
[release policy](https://github.com/CircuitWall/jarela/blob/04c47e876b3cc7f634d927fd0b0fb12acb0fc309/CONTRIBUTING.md#versioning).
In particular, nightly releases
still select minor versus patch by feature-commit count, not GitHub milestones.
A reviewed release-preparation PR must reconcile each planned minor with that
policy before publication; W0 documentation/tests alone do not trigger a minor.
If another release consumes a target version first, explicitly revise the
milestone mapping rather than silently treating that release as delivery.

### W0 initial baseline: 2026-10-28

Scope: source at `04c47e876b3cc7f634d927fd0b0fb12acb0fc309` (app manifest
3.0.1), plus the inert-discovery regression introduced with this baseline.
Observed runtime: Windows, Node 24.22.1, Vitest 5.0.5. This is a focused
foundation check, not a full release audit or live-provider evaluation.

The local hypothesis was that skill discovery and reading remain inert even
when a folder contains JavaScript, package hooks and malformed execution
metadata. The new synthetic test puts write-marker/throwing `.cjs` and `.mjs`
files beside Markdown and asserts unchanged prompt discovery/read behavior
with no marker created.

| Surface | Existing implementation and tests | Observed behavior / gap |
| --- | --- | --- |
| Skill assets and lifecycle | [loader](../lib/skills/index.ts), [loader tests](../lib/skills/index.test.ts), [agent tools/tests](../lib/tools/system/skills.test.ts) | Markdown discovery, repo precedence and writable-repo round trips pass; executable sidecars are inert. No explicit executable-bundle invocation contract |
| Deterministic skill checks | [fixtures](../lib/skills/fixtures.ts), [tests](../lib/skills/fixtures.test.ts) | Verdict/path assertions and rejection of non-read tools pass. Capability labels select tools; they do not sandbox their host code |
| Execution and environment | [one-shot wrapper](../lib/tools/general/exec.ts), [terminal session](../lib/terminal/session.ts), [environment](../lib/tools/security/subprocess-env.ts), [safety/tests](../lib/tools/security/safety.test.ts) | Safety classification tests pass. Existing execution accepts shell commands, inherits process/shell/injected environment, and session timeout returns a result without establishing descendant termination. Not a checked JSON skill runner |
| Progress and retry | [progress](../lib/tools/general/workflow-progress.ts), [progress tests](../lib/tools/general/workflow-progress.test.ts), [retry coordinator/tests](../lib/agents/workflow-step-retry.test.ts) | Checklist validation, rejected/mid-flight steps and bounded retry decisions pass. Existing limits are 3 attempts per step and 6 automatic retries per turn. Evidence text is not an executed validator or safe-write replay contract |
| Approval and interaction | [pending actions](../lib/stores/pending-actions.ts), [application](../lib/agents/proposals.ts), [application tests](../lib/agents/proposals.test.ts) | Existing configuration-action application tests pass. No reviewed artifact-bound skill action or typed durable workflow-question contract; application tests do not certify approval UI/race/restart behavior |
| Delegation and runtime compatibility | [delegate/tests](../lib/tools/delegation/delegate.test.ts), [runtime check/tests](../scripts/runtime-version.test.mjs) | Roster/cycle/depth/error fixtures and supported/unsupported version checks pass. Delegated runs are mocked; no semantic-selection or interrupted-write recovery claim |

Reuse decision: retain the skill loader/repo model, capability registry, safety
policy, progress reporting and existing approval lifecycle. Do not copy the
shell-command wrapper or credential-inheriting environment into a script
runner: its direct-argv, structured-output and explicit-environment invariants
are different. [ADR-0112](adr/0112-checked-javascript-skill-execution.md)
records a proposed boundary and numeric limits for review, not implemented
runtime behavior.

Reproduce the selected check using the installed runner:

```powershell
node node_modules\vitest\vitest.mjs run `
  lib\skills\index.test.ts lib\skills\fixtures.test.ts `
  lib\tools\system\skills.test.ts lib\tools\security\safety.test.ts `
  lib\tools\general\workflow-progress.test.ts `
  lib\agents\workflow-step-retry.test.ts lib\agents\proposals.test.ts `
  lib\tools\delegation\delegate.test.ts scripts\runtime-version.test.mjs
```

Observed result: **9 test files / 142 tests passed on each of 10 fresh-process
runs** (1,420 passing test executions). Each process used the existing isolated
test data-directory setup and per-suite synthetic fixtures. This repetition
applies only to these foundation tests, not to the full journey gates. It does
not prove host isolation, process-tree cleanup, privacy of arbitrary extensions,
other operating systems, Node 26 execution or live model reliability.

All five full workflow cards below remain **not run end-to-end**. Outstanding
W0 work is to assign accountable owners, select/reset their complete fixtures,
run the assisted-user walkthrough, review ADR-0112, and resolve the workflow
schema/budgets and interaction-state ADR. No release gate is marked complete.

### Unreleased W1 inspection increment

Work toward W1 includes opt-in inert manifest inspection through `read_skill`;
see the [experimental inspection contract](EXTENDING.md#inspecting-skill-execution-metadata-unreleased).
It checks the selected bundle's declarations and file metadata without importing
or running code. It always reports execution unavailable. This does not complete
W0, deliver a JavaScript runner, or satisfy W1's execution/approval gates.

### Journey traceability and cut lines

| Journey | Owning requirement/work | Earliest slice | Explicit cut line |
| --- | --- | --- | --- |
| J1. Make reusable | R7-R9 / W3 | After W1/W2 are independently verified | No automatic harvesting or activation |
| J2. Inspect/test/run | R7/R8 / W1/W2 | Inert inspection and checked JS run first | No visual workflow editor or generic dry-run promise |
| J3. Gap proposal | R1/R4/R9 / W0/W3 | Procedural prototype during baseline | No automatic development on denial or outage |
| J4. Routing inspection | R11 / W5 | Advertisement freshness/eligibility first | No live delegation during selection tests |
| J5. Receipt | R6/R8/R11 / W1/W2/W5 | Checked result view for each delivered slice | No parallel event database or invented evidence |
| J6. Portable bundle | R5/R10 / later candidate | Only after authoring/sharing need is observed | Not required by W1-W5 |
| J7. Upgrade report | R5 / later candidate | After compatibility fixtures exist | Report UI deferred, basic R5 checks retained |

For each implementation issue, select one bounded row/slice, an accountable
maintainer and an explicit fixture list. Do not treat every journey as a gate
for every release. W0 must establish numeric runtime/output/retry/prompt budgets
and their configuration bounds before the applicable runtime slice begins.
Per-PR gates apply to that slice and affected existing behavior; overall phase
exit requires coverage of all selected phase deliverables.

### Five baseline workflow cards

| Workflow | Input | Required output | Validation |
| --- | --- | --- | --- |
| Connect and recall | Synthetic document set, scoped source consent and exclusion | Answer with correct references; excluded documents not retrieved | Check fixture IDs, citations and exclusion behavior; distinguish embedding egress from recall |
| Execute and steer | Local task with a known file output and a long-running step | Correct artifact and visible cancellation/steering state | Assert file content and run state; no success claim after cancellation without a checked result |
| Delegate and recover | Bounded coding task, test fixture and interrupted delegate | Inspectable request/progress/result or explicit recoverable failure | Run the task assertion; verify duplicate external actions are not introduced by recovery |
| Extend a capability | Synthetic service or local fixture and a proposed extension | Authorized, working capability without editing core | Check schema, denial, trust warning, positive output and disable behavior |
| Upgrade and continue | Isolated prior-version fixture and candidate runtime/app | Existing state readable, supported extension usable, incompatible runtime rejected | Test backup/restore procedure and public contract; keep data migrations separate from runtime requirements |

These are proposed targets, not measured results:

- Require **10/10 passes** for each deterministic positive fixture before its
  phase exits, resetting state between attempts. Record test command, fixture
  revision, app/Node versions and assertion results. Repetition checks stability,
  not ten independent proofs of safety.
- Every enumerated deny, cancel, malformed-input and failure fixture must pass;
  passing only the happy path is insufficient.
- Require **zero observed unauthorized side effects or credential disclosures**
  in those fixtures. Any occurrence blocks the affected gate; finite tests do
  not prove universal safety.
- Run one documented assisted-user walkthrough and one second-author extension
  walkthrough. Record time, manual interventions and confusion as a baseline;
  set improvement targets only after measuring it.
- Live model/provider checks are separate, explicitly authorized and report
  attempts, failures, cost and uncertainty. Deterministic fixtures do not prove
  live model reliability.
- Apply the same repeated-fixture and negative-case gates to W1-W5. Report each
  runtime/platform actually tested; an optional interpreter that is absent must
  produce an actionable unavailable result, never a success-shaped skip.

Store sanitized evidence in the existing test/issue/review workflow, not a new
telemetry service. Do not mark a gate complete based on commit volume, line
counts, a model's self-assessment or a successful tool exit code alone.

## 7. Non-goals

- Exhaustive built-in coverage of external services or vertical business apps.
- Unbounded self-modification, automatic permission escalation or autonomous
  publication by agents.
- A mandatory marketplace, hosted control plane, cloud account or analytics.
- A new always-on service/broker, sandbox, persistence layout or replacement
  plugin framework in this PRD. Existing terminal execution already uses child
  processes; an authorized bounded script invocation is not a new resident
  service. Changes to execution isolation, process topology or durable state
  still require a focused ADR and operational/threat analysis.
- A visual workflow IDE, automatic skill harvesting, marketplace or routing
  leaderboard. Inspectable lists, explicit capture and local artifacts come first.
- Removing useful existing features to satisfy an arbitrary feature-count cap.
- Declaring Jarela "finished" or stopping runtime/dependency maintenance.

## 8. Risks, trade-offs and decision triggers

| Risk | Mitigation / trigger for reconsideration |
| --- | --- |
| Users inherit too much setup work | Measure walkthrough friction; improve shared discovery/setup before adding niche core features |
| Agent-generated code is mistaken for reviewed code | R2/R3 authorization and truthful host-trust warnings; no automatic execution of unknown artifacts |
| Ecosystem drifts across app/runtime upgrades | Reproducible fixtures, explicit supported surfaces and migration notes |
| Agent changes a working procedure into a broken one | Scoped diffs, versioned user-owned source and checked restoration; no claim that external side effects are reversible |
| Core stagnates behind an "extension-first" slogan | Reopen the boundary when multiple distinct tasks cannot be expressed safely using supported surfaces |
| Extension authors abandon connectors | Explicit owner/support expectations and exportable user-owned artifacts; no implied core-maintainer support |
| Roadmap grows into a second platform | Deliver one bounded slice at a time; J6/J7 stay candidates and no general-purpose workflow IDE is required |
| Generated advertisements leak private instruction detail | Explicit egress policy, minimized sources, bounded outputs and operator inspection; sanitization is not a universal privacy guarantee |

## 9. Adoption and follow-up

1. Direction accepted for planning on 2026-10-28; implementation contracts and
   release gates remain subject to focused review, not accepted by implication.
2. Track W0-W5 in the planned minor-upgrade issues above, referencing requirement
   IDs. Assign owners and complete the phase A observations before accepting W0.
3. Implement demonstrated gaps in separate PRs with explicit regression checks.
   Reuse current registries, stores, proposal paths and tests; do not launch a
   rewrite to satisfy this document.
4. Revisit this direction after the five workflows and extension walkthroughs
   have evidence, or when a concrete task fails the admission rule.

Open implementation decisions: the least disruptive artifact-bound approval
mechanism; which extension paths need stronger pre-import controls; the supported
previous-version test fixture; the skill bundle entry-point and workflow schema;
the initial JavaScript module formats and future language-support criteria;
ownership of coordinated retries;
and durable question/choice state and channel fallbacks. Resolve these from
phase A/W0 evidence and dedicated boundary ADRs before claiming implementation.
For W5, also resolve advertisement ownership/storage, prompt-budget overflow and
cross-agent run budgets before adding fields or changing prompt assembly.

### Design decisions required before implementation

| Decision | Owner to assign | Required evidence before the relevant slice |
| --- | --- | --- |
| JS entry point, module format, input/result protocol and immutable revision handling | Core execution maintainer | Dependency-free fixture, mutable-source test, timeout/cancel and child cleanup tests |
| File schema, binding rules, step states and coordinated budgets | Workflow maintainer | Inert parser, invalid-definition matrix and mixed deterministic run |
| Durable question/approval/job state, expiry and restart behavior | Persistence/runtime maintainer | Focused ADR, response-race tests and interrupted-run recovery design |
| Advertisement egress/model policy, source filtering and invalidation | Agent/prompt maintainer | Save-race fixtures, unavailable-model behavior and assembled prompt review |
| Slice scope, support ownership and live-evaluation budget | Accepting maintainer/operator | Named owner, selected acceptance cases and explicit authorization for external tests |

These roles are responsibilities to assign, not newly created teams. Unknown
numeric limits and storage designs are blockers to the affected implementation,
not license to select silent defaults.

### Document review: 2026-10-28

Reviewed R1-R11, W0-W5, the seven journeys and ADR-0111 for internal consistency,
requirement traceability and acceptance-test coverage against the grounding
snapshot. This is not a fresh runtime audit or evidence that proposed behavior
works.

Corrections made during review:

- Distinguished narrow workflow schema versioning from a universal plugin
  manifest, and bounded script children from a new resident service.
- Bound execution authority to the executable bundle/dependency revision and
  required mutation handling, rather than a top-level script name.
- Separated terminal run status from verified success, partial effects and skips.
- Included generation-policy changes in advertisement job identity while
  separating transient readiness from permission-derived claims.
- Distinguished required foundational slices from later bundle/report ideas,
  and clarified fixture isolation, acceptance ownership and decision blockers.

Open limits remain: full-trust code is not sandboxed; semantic privacy filtering
and model routing are best-effort; exact schema/module/state/budget contracts
need the focused designs above. No unresolved issue is being treated as an
implemented guarantee.
