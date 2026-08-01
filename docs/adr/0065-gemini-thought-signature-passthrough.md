# 0065 — Thread Gemini `thoughtSignature` through tool-call replay

Date: 2026-11-16

## Status

Accepted

## Context

Gemini 2.5+ models emit an opaque `thoughtSignature` field on parts they
produce during a turn. Once such a signature has been emitted, every
subsequent request in that conversation MUST replay it on the
`functionCall` part(s) it originally accompanied, or the API returns:

```
400 Function call is missing a thought_signature in functionCall parts of
the model turn at contents[N]. Please refer to
https://ai.google.dev/gemini-api/docs/thought-signatures
```

We hit this on the installed build after a `memory_write` tool call —
the second turn's request rebuilt history from the checkpointed
`AIMessage.tool_calls` list, which had no place to carry the signature,
and the follow-up request was rejected. Falling back to the
OpenAI-compatible endpoint did not help because it routes to the same
backend, which also 400s (silently, no error body).

## Decision

Carry Gemini's `thoughtSignature` as opaque provider-scoped metadata on
tool call objects at every layer:

1. **Provider surface** (`lib/tools/types.ts`, `lib/providers/types.ts`) —
   add optional `provider_meta?: Record<string, unknown>` to `ToolCallRef`,
   `ToolCall`, and the `tool_call_chunk` stream event.

2. **Gemini adapter** (`lib/providers/gemini.ts`) — in both the
   streaming and non-streaming decode paths, track the `thoughtSignature`
   attached to each part. When a `functionCall` part is emitted, use its
   own signature if present, otherwise the one from the most recent
   preceding thought part in the same candidate. Emit as
   `provider_meta: { gemini_thought_signature: sig }`. On replay
   (`invokeMessagesToGemini`), attach the signature as a sibling
   `thoughtSignature` field on the reconstructed `functionCall` part.

3. **LangChain bridge** (`lib/providers/jarela-chat-model.ts`) — on
   incoming `tool_call_chunk` events, park the metadata in
   `AIMessageChunk.additional_kwargs.provider_tool_call_meta` keyed by
   tool call id. LangChain's `AIMessageChunk.concat` merges
   `additional_kwargs` via recursive `_mergeDicts`, so the final
   aggregated `AIMessage` retains a full id → meta map. When translating
   `BaseMessage[]` back to `InvokeMessage[]` (`toInvokeMessages`), look
   the id up and attach to the outgoing `ToolCallRef.provider_meta`.

The field name is deliberately provider-scoped
(`gemini_thought_signature`) inside a generic `provider_meta` bag so
future providers with similar "echo back this opaque token" requirements
can piggyback without another cross-cutting change.

## Consequences

- Gemini turns that include thinking + tool calls no longer 400 on
  follow-up turns within the same thread.
- LangChain state stays serializable: `additional_kwargs` is already
  persisted by the checkpointer.
- The `provider_tool_call_meta` key on `AIMessage.additional_kwargs` is a
  new convention; other providers that gain equivalent requirements can
  reuse the same slot with their own provider-scoped metadata keys.
- Threads that started before this change still have `AIMessage.tool_calls`
  entries without signatures; those specific past turns can't be
  replayed successfully. Users must start a new thread or trim the
  history back before the first tool call.
- The Gemini OpenAI-compatible fallback path is unchanged. It cannot
  transport signatures (OpenAI's tool-call schema has no equivalent
  field), so operators who explicitly opt into
  `gemini_use_openai_compat` still face this failure mode. The native
  path is the default and now the correct one.

## References

- <https://ai.google.dev/gemini-api/docs/thought-signatures>
- LangChain `AIMessageChunk.concat` behaviour:
  `node_modules/@langchain/core/dist/messages/ai.cjs:209` — merges
  `additional_kwargs` via recursive `_mergeDicts`, safe for our
  id → meta map.
