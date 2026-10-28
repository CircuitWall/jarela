# ADR-0111: Dependable core and user-owned extensions after 3.0

Status: **Proposed**

Date: 2026-10-27

Last document review: 2026-10-28

Related product requirements: [Post-3.0 direction](../POST_3_DIRECTION.md)

## Context

Jarela already provides local-first agent orchestration, persistent state,
provider/tool registries, MCP, external plugins, packages, skills and configurable
harnesses. Continuing to absorb every domain-specific feature into core would
increase maintenance and compatibility costs without necessarily improving the
shared experience.

The proposed direction is to consolidate that workspace and let users, assisted
by their connected agents, own specialized capabilities. This is a hypothesis
to validate with representative workflows, not a declaration that the current
product is complete or universally reliable.

The 3.0 major boundary primarily reflects dropping Node 22 support: source/npm
users need Node 24.15.0+ on 24.x or Node 26+. It does not establish a new extension
architecture or sandbox. See the [3.0 changelog](../CHANGELOG.md#300-2026-10-27).

## Decision drivers

- Keep the local-first workspace dependable, coherent and maintainable.
- Avoid requiring core forks for supported domain extensions.
- Preserve user control over code execution, credentials and external effects.
- Give human and agent authors supported, testable extension contracts.
- Preserve working integrations and compatibility rather than forcing a rewrite.
- Prefer evidence of task friction over speculative feature accumulation.

## Proposed decision

Adopt **extension-first growth with a maintained, dependable core**:

1. Core owns shared orchestration, persistence, approval/credential boundaries,
   observability, recovery, extension contracts and compatibility guidance.
2. Users and extension authors own domain-specific connectors, procedures,
   personal workflows and agent specializations. Connected agents may help under
   the user's authorization; they are not independent trust authorities.
3. Route new requests through existing configuration, skills, workflows, MCP,
   plugins and packages before changing core. Escalate unsupported boundaries
   explicitly. Do not instruct agents to bypass them through internal imports.
4. Admit core additions when a reusable primitive is missing, multiple distinct
   workflows need it, or a maintained default is necessary for first-run value.
   Record placement, owner, maintenance cost and validation.
5. Maintain existing supported integrations. Deprecation/removal requires its own
   rationale, migration guidance and release communication.
6. Deliver in evidence-gated phases defined by the PRD; do not add a universal
   plugin framework, mandatory service or new process as part of this decision.

### Enabling capabilities under this direction

The proposed direction permits shared foundations needed to make extension
ownership practical:

- **Script-backed skills:** prompt-compatible bundles with explicit, authorized
  JavaScript entry points and checked results. JavaScript is the default and
  initial supported language, using Jarela's running Node executable rather than
  PATH lookup, without an additional interpreter or transpiler. Direct
  TypeScript, Python and shell-specific entry points are deferred; precompiled
  JavaScript can be supplied by authors.
- **File-defined verified workflows:** reviewable steps with input/output
  contracts, deterministic validation, coordinated bounded retries and typed
  human questions/choices.
- **Extension-development workflow:** a reusable procedure that discovers a
  capability gap, authors in inert staging, validates under authorization and
  proposes a reviewed extension for installation.
- **Contribution workflow:** a reusable opt-in procedure that sanitizes and
  validates a local change, then submits it only with publication authorization.
- **"Call me when" agent advertisements:** concise specialization descriptions
  in the active agent's authorized-delegate prompt catalog. The caller chooses
  a fitting specialist through existing delegation; agents are not each exposed
  as model-bound tools, and advertisements do not grant permission. Generate
  descriptions after routing-relevant config saves from saved instructions and
  canonical resolved permissions, under explicit configured model/egress policy.
  Keep generation separate from successful saving, fingerprint inputs, reject
  stale results and invalidate descriptions on relevant permission changes.
  Operators can inspect, regenerate or disable the derived description.

The first two are candidate shared primitives; the next two should primarily
compose those primitives rather than introduce new agent runtimes. See
[requirements R7-R10 and roadmap W0-W4](../POST_3_DIRECTION.md#r7-script-backed-skills).
Agent advertisements are a separate coordination improvement,
[R11/W5](../POST_3_DIRECTION.md#r11-call-me-when-discoverable-agent-specialization),
independent of file-workflow delivery. Reuse the existing available-delegates
prompt and roster-checked dispatch, preserve cycle/depth guards, and add bounded
handoff budgets where needed. This is not event-triggered execution, universal
agent discovery, a new router service or permission escalation.
Existing terminal execution and workflow retry nudges are reusable building
blocks, not proof that a file runner already exists.

The PRD's [user journeys](../POST_3_DIRECTION.md#5a-user-journeys-and-reusable-capability-lifecycle)
elaborate reuse capture, inert inspection/testing, capability-gap diagnosis,
routing inspection and checked completion receipts. They compose the proposed
requirements, not new subsystems. Portable bundles and richer upgrade reports
remain later candidates; they do not block the first JavaScript-backed slice.

Keep execution, validation, human response and security approval distinct:
loading a skill cannot execute scripts; validators are code too; a choice is
not execution consent; and uncertain external writes cannot be blindly retried.
An agent can develop a capability within a bounded task but cannot authorize
itself, modify trust policy to proceed, or publish as a side effect of success.

This ADR does not choose a serialization format, bundle schema, JavaScript
module formats or durable interaction schema. Those contracts need concrete design
and compatibility review. New persistence/process boundaries require separate
ADRs before implementation. Prompt-only skills must remain compatible.
An explicit schema version for a new file-workflow format does not replace
existing plugin contracts. Reusing bounded execution children is distinct from
introducing a new resident broker/service; changes to isolation or process
topology still need a focused decision.

### Trust boundary

This proposal builds on, but does not supersede,
[ADR-0013](0013-external-extension-contract.md): external code can run with full
Node privileges. Tool capability metadata and application invocation policies
are not host-code sandboxing. Loading a module, constructing a tool or installing
a package can execute code before a tool call.

The current [installer](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/lib/tools/packages/package-install.ts) allows
publisher-prefix-allowlisted packages immediately and holds other installs for
approval. That policy is not verified provenance or a safety guarantee.
Agent-generated artifacts receive no additional trust merely because an agent
authored them.

The target lifecycle must expose what will run, its source/artifact identity,
access needs, validation and recovery before authorization to install/import/run.
Use existing approval and trust-policy mechanisms where suitable; any behavior
change needs explicit compatibility and migration review. Test unknown artifacts
only in an appropriately authorized environment, not by importing them to
"inspect" their exports.

No stronger sandbox is claimed here. Introducing execution isolation, a process
boundary, new persistent state or a new permission model needs a separate ADR.
Until then, users must understand the existing full-trust execution boundary.

## Alternatives considered

| Alternative | Benefit | Reason not preferred |
| --- | --- | --- |
| Keep expanding built-in features | Consistent defaults and centralized support | Unbounded service-specific maintenance and a larger core surface |
| Freeze core and leave all problems to extensions | Small apparent roadmap | Abandons shared reliability, UX, compatibility and first-run needs |
| Build a marketplace or sandbox platform first | Could improve distribution or isolation | Adds architecture and operational scope before concrete workflow evidence |
| Dependable core with extension-first growth | Reuses existing boundaries and distributes specialization | Requires good authoring, diagnostics and explicit trust handling; chosen proposal |

## Consequences

### Expected benefits

- Core work can prioritize repeated workflow friction, simplification and recovery.
- Specialized capabilities can evolve without every change becoming an app release.
- Shared extension defects are addressed once at the owning boundary.
- Users retain control and portable source for their customizations.

### Costs and limits

- Users/authors carry real maintenance responsibility for their extensions.
- Agent assistance is fallible; review, validation and recovery remain necessary.
- In-process extension code remains full-trust unless a later decision changes it.
- A smaller built-in roadmap does not reduce runtime/dependency maintenance.
- Some valuable features still belong in core; this is a scope filter, not a ban.

## Validation and adoption

Before acceptance, review this ADR and the PRD together. Establish the five
workflow baselines in phase A. Before claiming delivery of each selected slice,
complete its applicable deterministic and negative checks. Phase C must
demonstrate both existing-extension configuration and new-extension authoring
without core patches. Record failures and unknowns, not just successes.
Validate script-backed skills, mixed file workflows, question/cancellation
handling and contribution publication gates separately before claiming those
capabilities delivered.
Scope checks to the delivered slice and affected behavior; the full baseline
program is a phase gate, not a requirement to build all proposed features in
one PR. The PRD's document-review record records consistency corrections and
remaining implementation decisions, not runtime certification.

This document alone changes no runtime behavior, permissions, public contracts,
storage schema, process topology or supported integrations. Existing C4 diagrams
remain the implementation map; future boundary changes must update them.

Revisit the decision if representative tasks repeatedly require internal patches,
users cannot make extensions work from documented paths, host-trust assumptions
are unacceptable, or required maintenance cannot be sustained.

## References

- [PRD: requirements, acceptance criteria and work ordering](../POST_3_DIRECTION.md)
- [Extension surfaces](../EXTENDING.md)
- [Current architecture](../ARCHITECTURE.md)
- [Public API and contribution contract at the grounding snapshot](https://github.com/CircuitWall/jarela/blob/c0851d6cacae380edd01d93f35ee4b93f3455935/CONTRIBUTING.md#public-api-surface)
