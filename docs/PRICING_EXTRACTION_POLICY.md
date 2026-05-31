# Pricing Extraction Policy

Purpose: guide pricing fetch and parsing so dashboard estimates stay resilient when provider pages change.

## Goals

- Produce normalized USD rates per provider and per model when possible.
- Prefer official provider-owned sources.
- Never hallucinate prices. Unknown values must stay null.
- Attach extraction confidence and inferred flags.

## Fetch strategy

1. Fetch the provider's official pricing URL.
2. If blocked or no usable rates, try provider fallback URLs.
3. If still missing, run search queries:
   - `<provider> API pricing`
   - `<provider> model pricing`
   - `<provider> token pricing`
4. Prefer official/provider-controlled domains first.
5. Use third-party pages only as a fallback and lower confidence.

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
