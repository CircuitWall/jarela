# ADR-0113: Gated bounded workflow runtime

Status: **Proposed; implementation permitted behind an inactive production gate**

Integration amendment (2026-10-30): [ADR-0114](0114-production-skill-workflow-integration.md)
supersedes the inactive-only coding boundary with explicit local app entry
points. This ADR preserves the rationale and limitations of the internal
increment; it is not the current activation guide.

Date: 2026-10-30

Related: [ADR-0112](0112-checked-javascript-skill-execution.md), W1/W2
[#827](https://github.com/CircuitWall/jarela/issues/827),
[#828](https://github.com/CircuitWall/jarela/issues/828).

## Decision

Continue implementation and deterministic testing without treating a request
to implement as permission to activate arbitrary host-code execution. No public
tool, route, startup hook or environment flag activates these internal modules.
Production launch remains disabled until artifact-bound approval integration
and platform process ownership have independent review and acceptance evidence.

The internal runner consumes an artifact, explicit invocation, resolved workspace,
run-scoped consent and a trusted host process-owner adapter. The adapter must
bound launch/termination and attest whole-owned-tree cleanup; ordinary child
exit or closed pipes cannot substitute for that evidence. No default process
adapter is supplied. Tests may supply adapters for reviewed synthetic fixtures,
without claiming cross-platform cleanup or executing user-supplied skills.

Run-owned staging belongs to `lib/stores`, below `JARELA_DB_DIR/skill-runs`.
Each unique directory contains only captured manifest/instructions/declared
bytes, reverified before launch. Writable workspace identity is separate.
Staging has no recoverable execution grant; restart never launches leftovers.
Explicit disposal removes only the owned directory after identity verification.
Failure to verify or dispose is reported, not silently treated as success.
Crash-leftover retention/cleanup remains a production-activation review item.
Mode bits are not a Windows ACL or a defense against hostile same-user code.

Workflow definitions are inert strict version-1 JSON with at most 32 sequential
steps. Sequential backward-only bindings are an acyclic subset; no loops,
dynamic executable text, expression language, parallel writes or implicit retries.
Step kinds are tool, script, validate and choice. Each has explicit input/output
schema and an input binding (literal, schema-checked invocation, or a previous
checked step's output). Invocation bytes are separately retained/validated and
do not change the reusable definition's content revision. Omitted run schema
accepts only an empty object, not arbitrary inputs.
Host adapters perform authorized operations and model-generated drafting; the
coordinator checks every machine-checkable contract and labels no model output
as deterministic merely because its schema passes.

One coordinator owns at most three attempts per read-only step and six retries
per run. Writes receive one attempt; any interrupted/inconclusive write becomes
`uncertain`, blocks downstream work and requires explicit observed reconciliation.
Denial/cancellation are terminal. Choice answers bind to run/revision/step and
the current persisted version, are validated and consumed once, and are not
execution consent. Restart recovers choices, not old script grants.

Durable workflow state uses a dedicated store and table, not generic memory
keys: versioned compare-and-swap updates prevent two owners claiming a step.
The inactive internal store creates its table only when explicitly used; no
startup/migration hook or active API introduces this proposed persistence into
existing installations. State is bounded JSON; no secrets or raw provider
transcripts are suitable inputs. Production retention, access control,
encryption/visibility and migration decisions remain activation gates.

After an owner-process restart, explicit recovery requires an independently
verified dead prior owner. Interrupted reads can be reset within remaining
attempt budgets; interrupted writes must reconcile. There is no automatic
startup replay, execution permission recovery or optimistic write retry.

## Validation and limits

Use synthetic memory-cleanup and briefing fixtures, exact-byte staging,
negative schema/binding tests, duplicate/stale choices, CAS races, interruption,
restart/reconciliation and cancellation. Reset runs must pass 10/10.
Internal adapter tests establish orchestration, not host-code authorization,
physical cross-host portability, human walkthroughs or descendant termination.

No milestone closure follows solely from these modules or passing unit tests.
The activation gates and accountable maintainer review in ADR-0112 remain.
