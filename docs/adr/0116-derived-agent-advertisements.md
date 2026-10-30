# ADR-0116: Derived agent advertisements

Status: Accepted for implementation; human release acceptance remains separate.

## Context

R11/W5 requires useful specialization descriptions without creating per-agent
tools or granting delegation authority. Existing routing exposes a first line
of private instructions and has depth/cycle checks but no shared task budget.
The falsifiable baseline is that config saves do not derive freshness-bound
metadata; config-store and assembled-catalog tests check that assumption.

## Decision

Reuse agent configs, the canonical tool catalog/permission resolver, configured
providers, the in-process keyed background-work pattern and existing SQLite
`memory_store`. No additional process, broker, telemetry or dependency.

The `agent-advertisements` namespace stores encrypted versioned derived rows.
The `agent-advertisement-policy` app-setting is disabled by default and names
one existing enabled model config explicitly. No default-model fallback.
Operators explicitly authorize egress of committed identity/instructions and
bounded public tool descriptions; no conversations, credentials or memory are
generation inputs. Structured outputs are model-generated descriptions, never
proof of ability or account authorization. Conservative leakage checks are not
a universal semantic privacy guarantee; operators can inspect/disable results.

Persist config first. A shared post-save hook invalidates changed routing
sources synchronously and schedules recomputation outside the write. Cosmetic
saves do not cause calls. Fingerprints cover source identity, instructions,
canonical granted capabilities (including proxy-reachable tools), bounded tool
metadata and generator version. Transient readiness and credentials are excluded.
Policy/model selection is a separate job identity. Catalog/API reads compare
current sources before exposing a result, so external policy/package/MCP
changes cannot expose stale claims. A single in-process worker coalesces saves;
late results must match both fingerprints and a live agent before publication.
Deletion and policy/per-agent disable revoke publication immediately.

Defaults bound generation to ten calls per rolling hour, 16,000 source characters,
1,024 output tokens and 30 seconds; output/input and hourly caps are editable
within strict schema bounds. These are usage limits, not a quoted monetary
price. No retries or unconfigured calls. A timed-out uncooperative provider
retains the worker slot until actual settlement; its late result is discarded.
Restart invalidates pending work instead of inventing completion.
The source default accommodates the canonical Basic-tool catalog; isolated
production fixtures rejected ordinary agents at the initially proposed 8,000
characters. Larger committed configurations still fail explicitly rather than
silently truncating authorized capabilities or private source text.

States are pending, ready, failed, stale and disabled. A valid config save is
never rolled back by a generation failure. Stored errors are bounded safe codes,
not provider responses. Generated values are encrypted at rest. Optional manual
overrides are intentionally not introduced; edit instructions and regenerate.
The derived namespace is excluded from general embedding/recall, and generic
memory reads/mutations cannot expose its identities or modify its policy/usage
ledger. Only the unlocked local advertisement API owns those controls.

Catalog entries are deterministic JSON data, not prompt instructions. Only the
authorized roster and actual invocation permission may expose identities.
Legacy entries use names, not private instruction excerpts. Overflow is explicit,
not silent truncation: omit generated claims first, and if the identity catalog
itself exceeds its bound report overflow and require a narrower roster.
Existing dispatch always rechecks current authority/readiness, even after queue
wait; advertisements never override a refusal.

Delegated work shares a trusted root-task call/time/cost budget across nesting,
sequential calls and fan-out. Reservations, cancellation and uncertain outcomes
must fail closed; no blind rerouting or retry. Existing depth/cycle guards,
target-side permissions, approval gates, queue and result provenance remain.
Production defaults are eight handoffs, a 120-second shared deadline and a
$1 canonical-pricing estimate allowance, not operator-editable settings.
Every delegated inference reserves a conservative bound before the provider
call using effective context/output limits and known canonical rates. Unknown
or inferred pricing refuses execution; missing usage retains the reservation.
Reported overruns consume the observed estimate and block further inference.
This is not a guarantee of provider billing: bounds depend on providers
honoring token limits and canonical prices matching their actual charges.
There are no automatic delegated-turn retries.

Task-only legacy handoffs remain supported: the trimmed task is required and
bounded to 4,000 characters, while optional context, expected output and
validation criteria receive bounded defaults. These defaults provide a
structural handoff contract, not proof of semantic result quality.
Optional context/expected-output/validation fields are capped at
6,000/800/1,200 characters; successful nonempty results at 16,000 characters
carry parent/child agent and thread provenance, used tools and elapsed time.
Delegated preparation/end-of-turn work omits automatic recall, cached warm
summaries, compaction/fact extraction and separate model-based citation audits
to avoid implicit unbudgeted inference. It retains hot history, deterministic
validation and explicit authorized tools. The parent owns semantic validation;
ordinary non-delegated behavior is unchanged.

## Validation and consequences

Deterministic tests cover saves/no-ops/duplicates, failed writes, coalescing,
late results/deletion, policy changes, output leakage/schema/capabilities,
unavailable models, freshness, prompt overflow/authorization and handoff budgets.
Production UI/API fixtures exercise explicit controls without live model calls.
Live semantic-selection quality, a named maintainer and human release acceptance
are separate gates; structural tests do not certify model judgment.
