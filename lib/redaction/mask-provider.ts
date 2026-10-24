// Provider-level redaction. getProvider() wraps every provider with this
// layer so all model traffic — chat turns, background calls (compaction,
// summaries, classifiers, pricing extraction), and embeddings — is masked
// before it leaves the process, and responses are rehydrated so callers keep
// working with real values locally (ADR-0064).

import type { ModelProvider, ProviderMessage, ProviderStreamEvent } from "@/lib/providers/types";
import { isRedactionEnabled } from "@/lib/stores/app-settings";
import { getCurrentMaskContext } from "./context";
import { createMaskContext, PLACEHOLDER_RE, type MaskContext } from "./mask";
import { maskContentWith, maskInvokeMessagesWith } from "./mask-messages";
import { loadRedactionConfig } from "./patterns";
import { StreamRehydrator } from "./stream-rehydrate";

// The active chat run's context keeps placeholder ids consistent with the
// turn; calls outside a run (background jobs, embeddings) get a fresh one.
export function resolveMaskContext(): MaskContext | null {
  const current = getCurrentMaskContext();
  if (current) return current;
  if (!isRedactionEnabled()) return null;
  return createMaskContext(loadRedactionConfig());
}

function rehydrateDeep(ctx: MaskContext, value: unknown): unknown {
  if (typeof value === "string") return ctx.rehydrate(value);
  if (Array.isArray(value)) return value.map((v) => rehydrateDeep(ctx, v));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, rehydrateDeep(ctx, v)]),
    );
  }
  return value;
}

async function* rehydrateTextStream(ctx: MaskContext, stream: AsyncIterable<string>): AsyncGenerator<string> {
  const rehydrator = new StreamRehydrator(ctx);
  for await (const chunk of stream) {
    const out = rehydrator.push(chunk);
    if (out) yield out;
  }
  const trailing = rehydrator.flush();
  if (trailing) yield trailing;
}

// Placeholders can split across deltas in every channel, so text, thinking,
// and each tool call's argument stream get their own rehydrator. Held-back
// text is flushed before `stop` and at end of stream.
async function* rehydrateEventStream(
  ctx: MaskContext,
  events: AsyncIterable<ProviderStreamEvent>,
): AsyncGenerator<ProviderStreamEvent> {
  const text = new StreamRehydrator(ctx);
  const thinking = new StreamRehydrator(ctx);
  const args = new Map<number, StreamRehydrator>();

  function* flush(): Generator<ProviderStreamEvent> {
    const t = text.flush();
    if (t) yield { type: "text", delta: t };
    const th = thinking.flush();
    if (th) yield { type: "thinking", delta: th };
    for (const [index, rehydrator] of args) {
      const rest = rehydrator.flush();
      if (rest) yield { type: "tool_call_chunk", index, args_delta: rest };
    }
  }

  for await (const event of events) {
    if (event.type === "text") {
      const delta = text.push(event.delta);
      if (delta) yield { ...event, delta };
    } else if (event.type === "thinking") {
      const delta = thinking.push(event.delta);
      if (delta) yield { ...event, delta };
    } else if (event.type === "tool_call_chunk") {
      let rehydrator = args.get(event.index);
      if (!rehydrator) {
        rehydrator = new StreamRehydrator(ctx);
        args.set(event.index, rehydrator);
      }
      const delta = event.args_delta ? rehydrator.push(event.args_delta) : event.args_delta;
      // Keep id/name/provider_meta chunks even when the args are held back.
      if (delta || event.id || event.name || event.provider_meta) yield { ...event, args_delta: delta || undefined };
    } else if (event.type === "citation") {
      yield { ...event, ...(event.snippet ? { snippet: ctx.rehydrate(event.snippet) } : {}) };
    } else if (event.type === "stop") {
      yield* flush();
      yield event;
    } else {
      yield event;
    }
  }
  yield* flush();
}

const redactedProviders = new WeakMap<ModelProvider, ModelProvider>();

export function withRedaction(provider: ModelProvider): ModelProvider {
  const cached = redactedProviders.get(provider);
  if (cached) return cached;

  const wrapped: ModelProvider = {
    name: provider.name,
    ...(provider.credentialProbe ? { credentialProbe: provider.credentialProbe } : {}),
    async chat(modelId, messages, params, signal) {
      const ctx = resolveMaskContext();
      if (!ctx) return provider.chat(modelId, messages, params, signal);
      const masked: ProviderMessage[] = messages.map((m) => ({ ...m, content: maskContentWith(ctx, m.content).content }));
      const result = await provider.chat(modelId, masked, params, signal);
      return { ...result, stream: rehydrateTextStream(ctx, result.stream) };
    },
  };
  if (provider.invoke) {
    wrapped.invoke = async (modelId, messages, params, tools, signal) => {
      const ctx = resolveMaskContext();
      if (!ctx) return provider.invoke!(modelId, messages, params, tools, signal);
      const result = await provider.invoke!(modelId, maskInvokeMessagesWith(ctx, messages), params, tools, signal);
      return {
        ...result,
        text: result.text === null ? null : ctx.rehydrate(result.text),
        tool_calls: rehydrateDeep(ctx, result.tool_calls) as typeof result.tool_calls,
      };
    };
  }
  if (provider.streamInvoke) {
    wrapped.streamInvoke = (modelId, messages, params, tools, signal) => {
      const ctx = resolveMaskContext();
      if (!ctx) return provider.streamInvoke!(modelId, messages, params, tools, signal);
      return rehydrateEventStream(
        ctx,
        provider.streamInvoke!(modelId, maskInvokeMessagesWith(ctx, messages), params, tools, signal),
      );
    };
  }
  if (provider.embed) {
    wrapped.embed = (modelId, inputs, params) => {
      const ctx = resolveMaskContext();
      return provider.embed!(modelId, ctx ? inputs.map((input) => ctx.maskText(input).text) : inputs, params);
    };
  }
  if (provider.listModels) wrapped.listModels = provider.listModels.bind(provider);

  redactedProviders.set(provider, wrapped);
  return wrapped;
}

// For model traffic that cannot go through a ModelProvider (image
// generation, text-to-speech). Returns the masked text; there is nothing to
// rehydrate because the response is not text. `speakable` swaps placeholders
// for a plain word so TTS doesn't read the placeholder syntax aloud.
export function maskOutboundText(text: string, opts: { speakable?: boolean } = {}): string {
  const ctx = resolveMaskContext();
  if (!ctx) return text;
  const masked = ctx.maskText(text).text;
  return opts.speakable ? masked.replace(PLACEHOLDER_RE, "redacted") : masked;
}
