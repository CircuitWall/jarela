import { z } from "zod";
import { readResponseTextCapped } from "@/lib/utils/http-json";

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_RATES_PER_SOURCE = 2000;

const PROVIDERS = new Set([
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "cohere",
  "moonshot",
  "qwen",
]);

const PROVIDER_ALIASES: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  deepseek: "deepseek",
  google: "google",
  gemini: "google",
  vertex_ai: "google",
  vertexai: "google",
  cohere: "cohere",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  kimi: "moonshot",
  qwen: "qwen",
  dashscope: "qwen",
};

const OpenRouterPayloadSchema = z.object({ data: z.array(z.unknown()) });
const OpenRouterModelSchema = z.object({
  id: z.string().min(1),
  pricing: z.record(z.string(), z.unknown()).optional(),
});
const LiteLlmEntrySchema = z.object({
  litellm_provider: z.string().optional(),
  input_cost_per_token: z.unknown().optional(),
  output_cost_per_token: z.unknown().optional(),
  cache_read_input_token_cost: z.unknown().optional(),
  cache_creation_input_token_cost: z.unknown().optional(),
}).passthrough();

export interface AggregatorModelRate {
  provider: string;
  model_id: string;
  route: string;
  input_per_1m_usd: number | null;
  output_per_1m_usd: number | null;
  cache_read_per_1m_usd: number | null;
  cache_write_per_1m_usd: number | null;
  has_conditional_pricing: boolean;
}

export interface AggregatorPricingSource {
  id: "openrouter" | "litellm";
  name: string;
  source_url: string;
  fetched_at: string;
  last_successful_at: string | null;
  ok: boolean;
  status: number | null;
  error: string | null;
  etag: string | null;
  model_rates: AggregatorModelRate[];
}

interface AggregatorSourceDefinition {
  id: AggregatorPricingSource["id"];
  name: string;
  url: string;
  parse: (payload: unknown, providerFilter: ReadonlySet<string>) => AggregatorModelRate[];
}

const SOURCES: AggregatorSourceDefinition[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1/models",
    parse: parseOpenRouter,
  },
  {
    id: "litellm",
    name: "LiteLLM catalog",
    url: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    parse: parseLiteLlm,
  },
];

export async function fetchAggregatorPricingSources(
  previous: readonly AggregatorPricingSource[] = [],
): Promise<AggregatorPricingSource[]> {
  const previousById = new Map(previous.map((source) => [source.id, source]));
  return Promise.all(SOURCES.map(async (source) => {
    const result = await fetchOne(source, new Set());
    const old = previousById.get(source.id);
    if (result.ok) return { ...result, last_successful_at: result.fetched_at };
    if (!old) return result;
    return {
      ...result,
      last_successful_at: old.last_successful_at ?? (old.ok ? old.fetched_at : null),
      model_rates: old.model_rates,
    };
  }));
}

async function fetchOne(
  source: AggregatorSourceDefinition,
  providerFilter: ReadonlySet<string>,
): Promise<AggregatorPricingSource> {
  const fetched_at = new Date().toISOString();
  try {
    const response = await fetch(source.url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Jarela pricing signal",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return failed(source, fetched_at, response.status, `HTTP ${response.status}`, response.headers.get("etag"));
    }

    const body = await readResponseTextCapped(response, MAX_RESPONSE_BYTES);
    if (body.truncated) {
      return failed(source, fetched_at, response.status, `Response exceeded ${MAX_RESPONSE_BYTES} bytes`, response.headers.get("etag"));
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.text) as unknown;
    } catch {
      return failed(source, fetched_at, response.status, "Aggregator returned invalid JSON", response.headers.get("etag"));
    }

    const model_rates = source.parse(payload, providerFilter);
    if (model_rates.length === 0) {
      return failed(source, fetched_at, response.status, "No usable model rates found", response.headers.get("etag"));
    }
    return {
      id: source.id,
      name: source.name,
      source_url: source.url,
      fetched_at,
      last_successful_at: null,
      ok: true,
      status: response.status,
      error: null,
      etag: response.headers.get("etag"),
      model_rates,
    };
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "Request timed out"
      : "Request failed";
    return failed(source, fetched_at, null, message, null);
  }
}

function failed(
  source: AggregatorSourceDefinition,
  fetched_at: string,
  status: number | null,
  error: string,
  etag: string | null,
): AggregatorPricingSource {
  return {
    id: source.id,
    name: source.name,
    source_url: source.url,
    fetched_at,
    last_successful_at: null,
    ok: false,
    status,
    error,
    etag,
    model_rates: [],
  };
}

function canonicalProvider(raw: string): string | null {
  const provider = PROVIDER_ALIASES[raw.trim().toLowerCase()];
  return provider && PROVIDERS.has(provider) ? provider : null;
}

function modelIdWithoutProvider(rawId: string, rawProvider: string): string {
  const id = rawId.trim().toLowerCase();
  const prefix = `${rawProvider.trim().toLowerCase()}/`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function perMillion(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const perToken = Number(raw);
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  return Number((perToken * 1_000_000).toPrecision(15));
}

function hasConditionalPricing(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => /^(?:overrides|pricing_tiers)$|(?:input|output|cache).*?(?:above|below|tier|threshold)|(?:above|below|tier|threshold).*?(?:input|output|cache)/i.test(key));
}

function parseOpenRouter(payload: unknown, providerFilter: ReadonlySet<string>): AggregatorModelRate[] {
  const parsed = OpenRouterPayloadSchema.safeParse(payload);
  if (!parsed.success) return [];
  const rates: AggregatorModelRate[] = [];
  for (const rawModel of parsed.data.data) {
    const modelResult = OpenRouterModelSchema.safeParse(rawModel);
    if (!modelResult.success) continue;
    const [rawProvider, ...modelParts] = modelResult.data.id.split("/");
    if (!rawProvider || modelParts.length === 0 || modelResult.data.id.includes(":")) continue;
    const provider = canonicalProvider(rawProvider.replace(/^~/, ""));
    if (!provider || (providerFilter.size > 0 && !providerFilter.has(provider))) continue;
    const model_id = modelParts.join("/").trim().toLowerCase();
    const pricing = modelResult.data.pricing ?? {};
    const input = perMillion(pricing.prompt);
    const output = perMillion(pricing.completion);
    if (!model_id || (input == null && output == null)) continue;
    rates.push({
      provider,
      model_id,
      route: "OpenRouter",
      input_per_1m_usd: input,
      output_per_1m_usd: output,
      cache_read_per_1m_usd: perMillion(pricing.input_cache_read),
      cache_write_per_1m_usd: perMillion(pricing.input_cache_write),
      has_conditional_pricing: Array.isArray(pricing.overrides) && pricing.overrides.length > 0,
    });
    if (rates.length >= MAX_RATES_PER_SOURCE) break;
  }
  return rates.sort(compareRates);
}

function parseLiteLlm(payload: unknown, providerFilter: ReadonlySet<string>): AggregatorModelRate[] {
  const parsed = z.record(z.string(), z.unknown()).safeParse(payload);
  if (!parsed.success) return [];
  const rates: AggregatorModelRate[] = [];
  for (const [rawId, rawEntry] of Object.entries(parsed.data)) {
    const entryResult = LiteLlmEntrySchema.safeParse(rawEntry);
    if (!entryResult.success || !entryResult.data.litellm_provider) continue;
    const rawProvider = entryResult.data.litellm_provider;
    const provider = canonicalProvider(rawProvider);
    if (!provider || (providerFilter.size > 0 && !providerFilter.has(provider))) continue;
    const model_id = modelIdWithoutProvider(rawId, rawProvider);
    const input = perMillion(entryResult.data.input_cost_per_token);
    const output = perMillion(entryResult.data.output_cost_per_token);
    if (!model_id || (input == null && output == null)) continue;
    rates.push({
      provider,
      model_id,
      route: rawProvider,
      input_per_1m_usd: input,
      output_per_1m_usd: output,
      cache_read_per_1m_usd: perMillion(entryResult.data.cache_read_input_token_cost),
      cache_write_per_1m_usd: perMillion(entryResult.data.cache_creation_input_token_cost),
      has_conditional_pricing: hasConditionalPricing(rawEntry as Record<string, unknown>),
    });
    if (rates.length >= MAX_RATES_PER_SOURCE) break;
  }
  return rates.sort(compareRates);
}

function compareRates(a: AggregatorModelRate, b: AggregatorModelRate): number {
  return a.provider === b.provider
    ? a.model_id.localeCompare(b.model_id)
    : a.provider.localeCompare(b.provider);
}