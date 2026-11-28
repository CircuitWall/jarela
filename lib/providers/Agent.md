---
description: "Use when: implementing, debugging, or extending LLM provider adapters in lib/providers/"
tools: [read, edit, search, execute]
reasoning-effort: high
---

# LLM Provider Adapter Agent

Scope: `lib/providers/` — provider adapters, credential resolution, streaming,
error classification, rate limiting, capabilities, and model limits.

Follow [AGENTS.md](../../AGENTS.md) and the
[provider list in docs/index.md](../../docs/index.md). [types.ts](./types.ts) is
the `@public` extension contract for in-tree adapters and
`~/.jarela/providers/*.cjs` plugins; breaking it requires the deprecation
process in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Architecture

```text
Agent runtime (lib/agents/llm.ts)
  ↓ standardized messages and params
ModelProvider (types.ts)
  ↓ provider-specific SDK/fetch
External LLM API
```

## Key principles

- **Credential isolation.** Keys are resolved at runtime, never logged, never
  placed in prompts, and never passed to tools.
- **Streaming is lazy.** Yield deltas and tool fragments as they arrive; do not
  buffer a response to return it whole.
- **Failures are classified.** Auth is permanent; rate limits carry retry
  metadata; transient stream failures are retryable.
- **Capabilities are explicit.** Adapters and the catalog declare vision, tools,
  JSON mode, search, audio, and files rather than guessing per call.
- **Hosted tools are opt-in.** A capability flag describes what the provider
  advertises; it never sends a provider-hosted request by itself. The OpenAI
  adapter requires `params.openai_web_search: true` and falls back to standard
  generation with a visible note when the provider rejects the option. The
  source-backed capability map fills the catalog badge but does not widen
  execution authority. Hosted-search citations use the existing `citation`
  event and declared-references side channel.
- **Formats convert once.** Each adapter maps Jarela messages to its provider
  and maps provider output back to the typed event union.
- **The outer boundary is mandatory.** Callers use `getProvider()`, which applies
  rate limiting and redaction; direct adapter construction bypasses both.

## Adapter surface and stream contract

- `name` and `chat()` are required. `invoke()`, `streamInvoke()`, `embed()`,
  `listModels()`, and `credentialProbe` are optional: an omitted method means
  the capability is absent, not that a generic fallback exists.
- The trailing `signal?: AbortSignal` is optional so older external plugins stay
  valid (ADR-0089). In-tree adapters must pass it through to the SDK/fetch so
  cancellation reaches the network, not just the consumer loop.
- `chat()` returns `{ stream: AsyncIterable<string> }` of text deltas.
  `streamInvoke()` is the structured path and yields the event union below.

| Event | Contract |
| --- | --- |
| `text` / `thinking` | Append the delta in order; thinking is not user-visible prose. |
| `tool_call_chunk` | First fragment carries `id` + `name`; later fragments carry `args_delta`. Assemble by `index`; preserve `provider_meta` for round-trips. |
| `citation` | Optional source/snippet/url; never fabricate a URL from an index. |
| `usage` | Map only fields the provider reports. Anthropic/OpenAI `thinking_tokens` are informational (already in `output_tokens`); Gemini's are disjoint and priced separately. |
| `audio_chunk` | Base64 payload plus MIME type; do not transcode in the adapter. |
| `provider_event` | Namespaced provider-specific payload; consumers must tolerate unknown names. |
| `stop` | Exactly one terminal event with `stop \| tool_use \| length`. Do not emit text after it. |

Malformed tool arguments are an error, not `{}`. Empty messages, oversized
content, and mid-stream failures are explicit cases in adapter tests.

## Provider change map

| Change | Required surfaces |
| --- | --- |
| New provider | Adapter module beside [builtins.ts](./builtins.ts), static registration there, runtime access through [index.ts](./index.ts) (rate-limited and redacted), catalog/limits/capability coverage, [docs/index.md](../../docs/index.md) provider list, co-located tests |
| New stream event | [types.ts](./types.ts) union, every adapter that can emit it, collectors/consumers, event-shape tests |
| New credential path | [credentials.ts](./credentials.ts), [provider-integrations.ts](./provider-integrations.ts), probe definition, doc-safety test |
| New model/limit | [known-context-windows.ts](./known-context-windows.ts), [capabilities.ts](./capabilities.ts), pricing snapshot when cost-visible |
| Retry/rate-limit change | [errors.ts](./errors.ts), [rate-limit.ts](./rate-limit.ts), stream and non-stream tests |

## Standard patterns

### 1. Implement the adapter

Provide `name` and `chat()`; add `invoke()` and `streamInvoke()` only when the
provider supports structured tool calls, `embed()` for embeddings, and
`listModels()` for a live catalog. Pass the trailing `signal` to the SDK or
`fetch`. Honor `params.base_url` where the SDK allows a self-hosted or
compatible endpoint. Register the adapter with a static import in
[builtins.ts](./builtins.ts); callers reach it through `getProvider()`.

### 2. Stream staged events

Yield `text` / `thinking` deltas immediately. Emit tool calls as
`tool_call_chunk` fragments (id and name first, then `args_delta`) and let the
consumer assemble them. Emit `usage` only for fields the provider reports, and
exactly one terminal `stop`. Preserve `provider_meta` where a round-trip needs
it.

### 3. Classify failures

Use [errors.ts](./errors.ts): `ProviderAuthError` for permanent auth failures,
`isAuthHttpStatus()` / `isAuthErrorMessage()` for classification, and
`isRetryableProviderStreamError()` for transient stream failures.
[rate-limit.ts](./rate-limit.ts) parses overrides and enforces concurrency.
Never retry auth failures, and never put request headers, keys, or provider
payloads in an error message.

### 4. Declare capabilities and limits

`modelCapabilities(provider, modelId)` returns the best-effort flags for saved
models; `listModels()` returns `ProviderCatalogModel` rows when a live catalog
exists. Known context and output limits come from
[known-context-windows.ts](./known-context-windows.ts) via
`getKnownModelLimits()`, `getKnownContextLength()`, and
`getKnownMaxOutputTokens()`. Unknown models must fall back safely rather than
claim unsupported capabilities.

### 5. Resolve credentials

`resolveProviderApiKey(provider, params)` in [credentials.ts](./credentials.ts)
uses this order: explicit `params.api_key` → the integration credential row →
the provider environment variable. Return `undefined` for missing
configuration; let the caller produce the auth error. Never log the value or
include it in a URL.

### 6. Stay inside the outer boundary

`getProvider()` in [index.ts](./index.ts) wraps every provider with
`withProviderRateLimits()` and `withRedaction()` from
[lib/redaction/mask-provider.ts](../redaction/mask-provider.ts). Application
code must use it; constructing an adapter directly bypasses both protections.

## Anti-patterns

- **Keys in code, logs, errors, or prompts** — they persist in backups, caches,
  and transcripts.
- **Assuming a message shape** — `content` is a string or `ContentPart[]`;
  convert every part type explicitly.
- **Retrying auth or treating all errors alike** — wastes time and can lock an
  account. Classify first.
- **Buffering a whole stream** — defeats streaming and risks memory blowups.
- **Provider-specific shortcuts in shared code** — request shaping belongs in
  the adapter, not in agents or tool code.
- **Bypassing `getProvider()`** — skips rate limiting and redaction.
- **Breaking the `@public` interface** — external plugins depend on optional
  methods and the trailing signal; use the deprecation process.

## File map

| Concern | Files |
| --- | --- |
| Adapters | [anthropic.ts](./anthropic.ts), [openai.ts](./openai.ts), [gemini.ts](./gemini.ts), [deepseek.ts](./deepseek.ts), [github-copilot.ts](./github-copilot.ts), [langchain.ts](./langchain.ts), [external.ts](./external.ts), [mock.ts](./mock.ts) |
| Contract and registry | [types.ts](./types.ts), [registry.ts](./registry.ts), [index.ts](./index.ts), [builtins.ts](./builtins.ts) |
| Credentials and errors | [credentials.ts](./credentials.ts), [provider-integration-map.ts](./provider-integration-map.ts), [provider-integrations.ts](./provider-integrations.ts), [errors.ts](./errors.ts), [rate-limit.ts](./rate-limit.ts) |
| Capabilities and limits | [capabilities.ts](./capabilities.ts), [known-context-windows.ts](./known-context-windows.ts) |
| Streaming and tools | [streaming.ts](./streaming.ts), [tool-arguments.ts](./tool-arguments.ts), [tool-limit.ts](./tool-limit.ts), [jarela-chat-model.ts](./jarela-chat-model.ts) |
| External template | [template-external.cjs.example](./template-external.cjs.example) |

Cohere has no dedicated adapter: it runs through [langchain.ts](./langchain.ts)
(`provider: "langchain"`, `params.lc_class: "ChatCohere"`), which is text-only —
`@langchain/cohere` rejects image, audio, and file parts.

## Testing requirements

- Adapter tests are co-located: [anthropic.test.ts](./anthropic.test.ts),
  [openai.test.ts](./openai.test.ts), [gemini.test.ts](./gemini.test.ts),
  [github-copilot.test.ts](./github-copilot.test.ts),
  [langchain.test.ts](./langchain.test.ts), [mock.test.ts](./mock.test.ts).
  DeepSeek shares the OpenAI-compatible adapter coverage; add a dedicated test
  when its request shaping diverges.
- Error classification: [errors.test.ts](./errors.test.ts); rate limiting:
  [rate-limit.test.ts](./rate-limit.test.ts).
- Capabilities and limits: [capabilities.test.ts](./capabilities.test.ts),
  [known-context-windows.test.ts](./known-context-windows.test.ts).
- Registry, external-plugin compatibility, and redaction/rate-limit wrapping:
  [index.test.ts](./index.test.ts), [registry.test.ts](./registry.test.ts),
  [external.test.ts](./external.test.ts).
- Credential mapping: [provider-integrations.test.ts](./provider-integrations.test.ts).
- Mock the SDK or `fetch`; never call a live provider in unit tests. Cover
  message conversion, event order, tool fragments, usage, `stop`, mid-stream
  failure, and abort.
- Provider-hosted search: request shape with and without the option, fallback
  classification/retry, and citation mapping in
  [openai.test.ts](./openai.test.ts); citation side-channel behavior in
  [jarela-chat-model.test.ts](./jarela-chat-model.test.ts).
- Run the focused Vitest files, `npx tsc --noEmit`, and `npm run lint`.

## Review checks

- [ ] No secret appears in code, logs, errors, or prompts.
- [ ] Message and content-part conversion is complete.
- [ ] Auth, rate-limit, transient, and permanent failures are classified.
- [ ] The stream yields deltas/fragments progressively and ends with one `stop`.
- [ ] Capabilities and known limits are accurate; unknown models fall back.
- [ ] Credentials resolve in params → integration → env order.
- [ ] Provider access goes through `getProvider()`.
- [ ] External plugin compatibility and `@public` types are preserved.
- [ ] Focused tests, `npx tsc --noEmit`, and `npm run lint` pass.
