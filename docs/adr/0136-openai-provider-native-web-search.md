# ADR-0136: Opt-in OpenAI provider-native web search

Status: **Accepted**

Date: 2026-11-28

Related: [ADR-0108](./0108-deepseek-web-tool-backend.md) (standalone search
backend), [ADR-0037](./0037-agent-output-validator.md) (post-turn citation
audit), [ADR-0068](./0068-provider-auth-error-surface.md) (provider error
classification), [ADR-0091](./0091-durable-agent-system-signals.md) (provider
event and completion conventions).

## Context

OpenAI's model documentation advertises **web search** for the GPT-6.x family
(`gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6.1-terra`, `gpt-6-luna`, `gpt-6-astra`,
`gpt-6.1-sol`). The refresh pipeline records that observation as an adoption
candidate, but Jarela has no runtime path for it:

- `lib/providers/openai.ts` sends only client-side function tools. It never
  requests a provider-hosted search option and never parses the citation
  annotations the provider returns.
- `fetchOpenAICatalog` hardcodes `web_search: false`, so the Models panel can
  never show support even when the source-backed metadata overlay says the
  model advertises it.
- Jarela's own `web_search` tool remains the default and is not replaced by
  this decision.

The OpenAI adapter uses Chat Completions for every structured call. A Responses
API implementation would be a second transport with a different message,
tool-call, and streaming shape. This slice therefore takes the Chat Completions
path and records the Responses transport as a separate future decision.

## Decision

1. **Explicit per-model opt-in.** A model config may set
   `params.openai_web_search: true`. The Models editor exposes the toggle only
   for the `openai` provider. The adapter sends the hosted-search option when
   the flag is true; the source-backed capability map fills the catalog badge
   but is advisory, so a refresh-discovered model does not silently ignore the
   user's opt-in. Existing threads do not change behaviour.
2. **Chat Completions, not a second transport.** When enabled,
   `invoke`/`streamInvoke` add `web_search_options: {}` to the Chat Completions
   request. `chat()` (summary/compaction paths) never enables hosted search, so
   background text compression does not incur search cost.
3. **Citations reuse the declared-references pipeline.** The adapter maps
   `url_citation` annotations to the existing `citation` stream event.
   `JarelaChatModel` collects them and appends the established
   `jarela-references` fence after the text. `run-thread` already strips that
   fence, merges the entries into the source manifest, and exposes them in the
   References panel. This is visible citation evidence, not an invisible fold
   into the answer. Citations are dropped when the same provider turn also
   carries function tool calls, because the agent loop continues and no single
   final answer exists yet.
4. **Bounded fallback.** If the provider rejects `web_search_options` with a
   clear unsupported-parameter/model error, the adapter logs a warning, emits an
   `openai.web_search_fallback` provider event, and retries the same request
   without hosted search. The fallback note is also streamed as a short visible
   note so the user knows the answer used standard generation. Auth, rate-limit,
   and transient failures are never retried by this path.
5. **Catalog capability stays source-backed.** `fetchOpenAICatalog` derives
   `web_search` from `modelCapabilities` instead of hardcoding `false`. The
   weekly model-metadata refresh can override the static heuristic with an
   observed `value`, and the existing `withModelMetadata` overlay applies that
   observation. The badge describes provider-advertised capability, not proof
   that a saved model has the opt-in enabled.
6. **Cost is disclosed, not estimated.** Provider-hosted search is billed by
   the provider outside Jarela's per-model token rates. The model editor hint
   and provider guide state that the per-turn estimate excludes search billing;
   this slice does not invent a price for it.

## Consequences

- The feature is unavailable to models that do not advertise web search and to
  accounts that reject the hosted option; the fallback preserves the previous
  answer path.
- The Chat Completions transport exposes citations, not a separate
  `web_search_call` output item. A future Responses transport could surface the
  call itself, but it is a new decision, not an implied part of this slice.
- The opt-in is per model config, not per agent. Two agents sharing a model
  config share the setting.
- Citation labels and URLs are provider output. They are validated for shape
  and deduplicated by URL, but they remain untrusted source data.
- No new process, persistence schema, data-directory path, package, or network
  call on the default path.

## Verification

- `lib/providers/openai.test.ts`: request shape with the hosted option present
  and absent, fallback classification and retry, and annotation-to-citation
  mapping.
- `lib/providers/jarela-chat-model.test.ts`: citations become one
  `jarela-references` fence, deduplicated by URL, and suppressed on tool-call
  turns.
- `lib/providers/capabilities.test.ts`: GPT-6.x advertises web search; other
  OpenAI families do not.
- `app/api/v1/providers/[provider]/models/route.test.ts`: live OpenAI catalog
  rows report `web_search` for advertising models and `false` for others.
- `lib/models/editor-payload.test.ts`: the toggle round-trips only for the
  OpenAI provider.
- `npx tsc --noEmit`, `npm run lint`, and the focused suites above.

Live provider behaviour, actual search billing, and semantic citation quality
are not verified by these deterministic tests; they require an authorized
account and are reported separately.
