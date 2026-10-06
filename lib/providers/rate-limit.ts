import PQueue from "p-queue";
import { z } from "zod";
import type { ModelProvider, ProviderParams } from "./types";

export interface ProviderRateLimits {
  requestsPerMinute: number;
  maxConcurrent: number;
}

export const DEFAULT_PROVIDER_RATE_LIMITS: Readonly<Record<string, ProviderRateLimits>> = {
  anthropic: { requestsPerMinute: 1000, maxConcurrent: Infinity },
  openai: { requestsPerMinute: 60, maxConcurrent: Infinity },
  gemini: { requestsPerMinute: 5, maxConcurrent: Infinity },
  "github-copilot": { requestsPerMinute: 10, maxConcurrent: Infinity },
  cohere: { requestsPerMinute: 20, maxConcurrent: Infinity },
  deepseek: { requestsPerMinute: Infinity, maxConcurrent: 500 },
};

const unlimited: ProviderRateLimits = { requestsPerMinute: Infinity, maxConcurrent: Infinity };
const limitSchema = z.number().int().positive().max(60_000).nullable().optional();
const overridesSchema = z.record(z.string(), z.object({
  requestsPerMinute: limitSchema,
  maxConcurrent: limitSchema,
}).strict());

export function parseRateLimitOverrides(raw: string): Record<string, Partial<ProviderRateLimits>> {
  if (!raw.trim()) return {};
  const parsed = overridesSchema.parse(JSON.parse(raw));
  return Object.fromEntries(Object.entries(parsed).map(([name, limits]) => [name, {
    ...(limits.requestsPerMinute !== undefined
      ? { requestsPerMinute: limits.requestsPerMinute ?? Infinity } : {}),
    ...(limits.maxConcurrent !== undefined
      ? { maxConcurrent: limits.maxConcurrent ?? Infinity } : {}),
  }]));
}

export class ProviderRateLimiter {
  private readonly queues = new Map<string, PQueue>();

  constructor(private readonly overrides: Record<string, Partial<ProviderRateLimits>> = {}) {}

  limitsFor(providerName: string, params: ProviderParams = {}): ProviderRateLimits {
    const name = this.providerName(providerName, params);
    return { ...(DEFAULT_PROVIDER_RATE_LIMITS[name] ?? unlimited), ...this.overrides[name] };
  }

  private providerName(providerName: string, params: ProviderParams): string {
    return providerName === "langchain" && params.lc_class === "ChatCohere" ? "cohere" : providerName;
  }

  async acquire(providerName: string, params: ProviderParams, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const name = this.providerName(providerName, params);
    const limits = this.limitsFor(providerName, params);
    if (!Number.isFinite(limits.requestsPerMinute) && !Number.isFinite(limits.maxConcurrent)) {
      return () => {};
    }
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new PQueue({
        concurrency: limits.maxConcurrent,
        intervalCap: Number.isFinite(limits.requestsPerMinute) ? 1 : Infinity,
        interval: Number.isFinite(limits.requestsPerMinute) ? Math.ceil(60_000 / limits.requestsPerMinute) : 0,
        strict: Number.isFinite(limits.requestsPerMinute),
      });
      this.queues.set(name, queue);
    }
    const granted = Promise.withResolvers<() => void>();
    const finished = Promise.withResolvers<void>();
    const release = () => finished.resolve();
    const queuedController = new AbortController();
    const abortQueued = () => queuedController.abort(signal?.reason);
    signal?.addEventListener("abort", abortQueued, { once: true });
    void queue.add(async () => {
      signal?.removeEventListener("abort", abortQueued);
      signal?.throwIfAborted();
      granted.resolve(release);
      await finished.promise;
    }, { signal: queuedController.signal }).catch(granted.reject).finally(() => {
      signal?.removeEventListener("abort", abortQueued);
    });
    return granted.promise;
  }
}

function leasedStream<Value>(source: AsyncIterable<Value>, release: () => void, signal?: AbortSignal): AsyncIterable<Value> {
  const iterator = source[Symbol.asyncIterator]();
  let closed = false;
  const finish = () => {
    closed = true;
    signal?.removeEventListener("abort", abortStream);
    release();
  };
  const close = async (): Promise<IteratorResult<Value>> => {
    if (closed) return { done: true, value: undefined };
    closed = true;
    try {
      return await iterator.return?.() ?? { done: true, value: undefined };
    } finally {
      finish();
    }
  };
  const abortStream = () => { void close().catch(() => {}); };
  signal?.addEventListener("abort", abortStream, { once: true });
  if (signal?.aborted) abortStream();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          try {
            signal?.throwIfAborted();
            if (closed) return { done: true as const, value: undefined };
            const result = await iterator.next();
            signal?.throwIfAborted();
            if (result.done) finish();
            return result;
          } catch (error) {
            await close();
            throw error;
          }
        },
        return: close,
      };
    },
  };
}

export function withProviderRateLimits(provider: ModelProvider, limiter: ProviderRateLimiter): ModelProvider {
  const wrapped: ModelProvider = {
    name: provider.name,
    async chat(modelId, messages, params, signal) {
      const release = await limiter.acquire(provider.name, params, signal);
      try {
        signal?.throwIfAborted();
        const result = await provider.chat(modelId, messages, params, signal);
        return {
          stream: leasedStream(result.stream, release, signal),
        };
      } catch (error) {
        release();
        throw error;
      }
    },
  };
  if (provider.invoke) {
    wrapped.invoke = async (modelId, messages, params, tools, signal) => {
      const release = await limiter.acquire(provider.name, params, signal);
      try {
        signal?.throwIfAborted();
        return await provider.invoke!(modelId, messages, params, tools, signal);
      } finally {
        release();
      }
    };
  }
  if (provider.streamInvoke) {
    wrapped.streamInvoke = async function* (modelId, messages, params, tools, signal) {
      const release = await limiter.acquire(provider.name, params, signal);
      try {
        signal?.throwIfAborted();
        for await (const event of provider.streamInvoke!(modelId, messages, params, tools, signal)) {
          signal?.throwIfAborted();
          yield event;
        }
      } finally {
        release();
      }
    };
  }
  if (provider.embed) {
    wrapped.embed = async (modelId, inputs, params) => {
      const release = await limiter.acquire(provider.name, params);
      try {
        return await provider.embed!(modelId, inputs, params);
      } finally {
        release();
      }
    };
  }
  if (provider.listModels) wrapped.listModels = provider.listModels.bind(provider);
  return wrapped;
}