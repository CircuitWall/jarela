# Pricing Extraction Policy

Purpose: guide pricing fetch and parsing so dashboard estimates stay resilient when provider pages change.

## Verified extraction workflow

Treat each stage as a contract: validate its output before passing it to the next
stage. Prefer deterministic code checks to manual inspection wherever possible.

1. **Select sources**
   - **Input:** provider identifiers, supported model IDs and aliases, and
     configured official and fallback pricing URLs.
   - **Output:** an ordered source list for each provider, with source ownership
     classified as official/provider-controlled, aggregator, or third-party.
   - **Validation:** reject unsupported providers and malformed URLs; verify
     source ownership before assigning confidence or using a source for direct
     provider rates.
2. **Fetch source data**
   - **Input:** the selected source list and fetch time.
   - **Output:** a fetch result per source containing its URL, status, fetch
     time, and response data or an explicit failure.
   - **Validation:** check HTTP status and response format. On aggregator feed
     failure, retain last-successful feed data and report the current failure
     separately; do not treat stale data as a successful fetch.
3. **Extract and normalize rates**
   - **Input:** successful response data, supported provider/model identifiers,
     and recognized price units.
   - **Output:** normalized USD-per-million-token provider/model rates, with
     input/output values, inferred flags, confidence, and source attribution.
   - **Validation:** use deterministic parsing and schema/type/range checks;
     reject malformed, negative, sentinel, or unsupported records. Keep unknown
     numeric values null rather than guessing.
4. **Reconcile signals**
   - **Input:** validated direct-provider rates and separately stored
     OpenRouter/LiteLLM comparison signals.
   - **Output:** canonical model matches and explicit discrepancy warnings.
   - **Validation:** match only by supported canonical provider/model IDs after
     known alias normalization. Never merge aggregator quotes into direct
     provider prices or billing estimates; surface disagreements rather than
     selecting a winner automatically.
5. **Publish snapshot**
   - **Input:** validated normalized rates, source metadata, fetch outcomes, and
     warnings.
   - **Output:** a snapshot conforming to the output contract below.
   - **Validation:** enforce the snapshot schema and required provenance,
     nullability, and confidence rules in code; add or run focused tests for
     parsing, normalization, feed failures, and separation of aggregator data
     from direct rates.

## Goals

- Produce normalized USD rates per provider and per model when possible.
- Prefer official provider-owned sources.
- Never hallucinate prices. Unknown values must stay null.
- Attach extraction confidence and inferred flags.

## Fetch strategy

1. Fetch the provider's official pricing URL.
2. If blocked or no usable rates, try provider fallback URLs.
3. Fetch the OpenRouter and LiteLLM catalogs as separate aggregator signals.
   Match supported providers and model IDs exactly after known alias normalization.
   These are route/catalog quotes, not direct-provider prices, and must never
   replace rates used for direct-provider cost estimates.
4. If official sources are still missing, run search queries:
   - `<provider> API pricing`
   - `<provider> model pricing`
   - `<provider> token pricing`
5. Prefer official/provider-controlled domains first.
6. Use third-party pages only as a fallback and lower confidence.

## Aggregator signals

- Store OpenRouter and LiteLLM rates in a separate snapshot section with the
  aggregator, route, source URL, fetch time, and last-success time.
- Normalize per-token prices to USD per million tokens; preserve cache prices
  and flag conditional/tiered pricing rather than flattening it silently.
- Skip sentinel, negative, malformed, unsupported-provider, and unsupported-model
  records. A feed failure keeps the last successful feed data and reports the
  failure separately.
- Show aggregator prices as comparison signals with source attribution. Never
  blend or average them into direct-provider prices or billing estimates.
- Compare feeds only after canonical model matching. Differences are expected
  when an aggregator's route, discounts, or vendor-specific tier differs; surface
  the discrepancy for review instead of choosing one automatically.

## Parsing strategy

1. Accept common unit formats:
   - `$X / 1M tokens`
   - `$X per million tokens`
   - `$X / MTok`
2. Detect explicit `input` and `output` labels when present.
3. If only one token rate is available, use it for both input/output and mark as inferred.
4. Extract model IDs when discoverable (for example `gpt-4o`, `claude-sonnet-4`, `gemini-2.5-pro`).
5. Build provider-level fallback rates from signal sets when model-level extraction is missing.

## Confidence rules

- `high`: official domain and explicit input/output rates for a model/provider.
- `medium`: official domain with strong but partially inferred signal.
- `low`: ambiguous structure, single-rate inference, or non-official source.

## Output contract

- Provider entry:
  - provider
  - source_url
  - fetched_ok, status_code
  - input_per_1m_usd, output_per_1m_usd
  - inferred, confidence
- Model entry:
  - provider, model_id
  - input_per_1m_usd, output_per_1m_usd
  - inferred, confidence
- Warnings list describing why a value is missing or inferred.

## Guardrails

- Do not fabricate missing prices.
- Preserve null for unknown numeric fields.
- Keep original source URL for traceability.
- Favor deterministic parsing over speculative heuristics.

## Model version and capability updates

The agent pricing-maintenance tool additionally reads a bounded list of official
model/API documentation pages. This is separate from price extraction:
third-party pricing search results and aggregator feeds cannot establish model
capabilities.

- **Input:** official documentation, provider identity, and the configured
  pricing extractor model.
- **Output:** exact API model IDs, explicitly current release/version mappings,
  sparse capability observations, standalone Search/Fetch API observations,
  source health, change reports, and adoption-review candidates.
- **Validation:** strict Zod output schemas; bounded model/feature counts;
  verbatim source quotes containing the relevant model ID (and version for
  version claims); explicit API evidence for standalone features; reject
  conflicting observations. Requests have timeouts, bounded responses, and
  same-origin-only redirects. Truncated source text is disclosed.

Omitted capability keys remain unknown. Only explicit negative statements can
produce `false`; absence never removes a capability or deletes a model.
Observations retain per-field provenance in SQLite via `lib/stores/model-metadata`.
Catalog and saved-model UI metadata may change, but runtime adapter behavior,
model assignments, credentials, context budgets, and recorded costs do not.
Verbatim evidence checks establish provenance, not semantic certainty: model
extraction still requires scrutiny and live capability use requires separate
validation.

Report standalone APIs separately from model-native capabilities. Escalate
confirmed adapter/integration gaps through deduplicated GitHub issues using
the agent's existing permissions. Missing code access, GitHub access, or approval
must remain explicit blockers. See [ADR-0107](adr/0107-source-backed-model-metadata.md)
and [operating guidance](OPERATIONS.md#review-usage).
