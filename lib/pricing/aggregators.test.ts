import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAggregatorPricingSources } from "./aggregators";

afterEach(() => vi.unstubAllGlobals());

describe("aggregator pricing sources", () => {
  it("normalizes OpenRouter per-token prices without treating them as direct rates", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openrouter.ai")) {
        return Response.json({ data: [
          {
            id: "deepseek/deepseek-v4-pro",
            pricing: {
              prompt: "0.00000132",
              completion: "0.00000396",
              input_cache_read: "0.000000044",
              overrides: [{ min_prompt_tokens: 200000, prompt: "0.000002" }],
            },
          },
          { id: "openai/gpt-5.4:batch", pricing: { prompt: "0.000002", completion: "0.00001" } },
          { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
        ] });
      }
      return Response.json({});
    }));

    const sources = await fetchAggregatorPricingSources();
    const openrouter = sources.find((source) => source.id === "openrouter");

    expect(openrouter?.ok).toBe(true);
    expect(openrouter?.model_rates).toEqual([{
      provider: "deepseek",
      model_id: "deepseek-v4-pro",
      route: "OpenRouter",
      input_per_1m_usd: 1.32,
      output_per_1m_usd: 3.96,
      cache_read_per_1m_usd: 0.044,
      cache_write_per_1m_usd: null,
      has_conditional_pricing: true,
    }]);
  });

  it("uses LiteLLM's declared provider and skips unsupported host providers", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("litellm")) {
        return Response.json({
          "deepseek/deepseek-v4-pro": {
            litellm_provider: "deepseek",
            input_cost_per_token: 0.00000132,
            output_cost_per_token: 0.00000396,
            cache_read_input_token_cost: 0.000000044,
            max_input_tokens: 131072,
          },
          "azure/gpt-5.4": {
            litellm_provider: "azure",
            input_cost_per_token: 0.000002,
            output_cost_per_token: 0.00001,
          },
          "gemini/gemini-2.5-flash": {
            litellm_provider: "gemini",
            input_cost_per_token: 0.0000003,
            output_cost_per_token: 0.0000025,
          },
        });
      }
      return Response.json({ data: [] });
    }));

    const sources = await fetchAggregatorPricingSources();
    const litellm = sources.find((source) => source.id === "litellm");

    expect(litellm?.ok).toBe(true);
    expect(litellm?.model_rates).toHaveLength(2);
    expect(litellm?.model_rates).toEqual(expect.arrayContaining([{
      provider: "deepseek",
      model_id: "deepseek-v4-pro",
      route: "deepseek",
      input_per_1m_usd: 1.32,
      output_per_1m_usd: 3.96,
      cache_read_per_1m_usd: 0.044,
      cache_write_per_1m_usd: null,
      has_conditional_pricing: false,
    }, {
      provider: "google",
      model_id: "gemini-2.5-flash",
      route: "gemini",
      input_per_1m_usd: 0.3,
      output_per_1m_usd: 2.5,
      cache_read_per_1m_usd: null,
      cache_write_per_1m_usd: null,
      has_conditional_pricing: false,
    }]));
  });

  it("returns source health failures instead of throwing or inventing zero rates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("blocked", { status: 403 })));

    const sources = await fetchAggregatorPricingSources();
    expect(sources).toHaveLength(2);
    expect(sources.every((source) => !source.ok && source.status === 403 && source.model_rates.length === 0)).toBe(true);
  });

  it("preserves the last successful catalog when a feed becomes unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("blocked", { status: 403 })));
    const oldRate = {
      provider: "deepseek",
      model_id: "deepseek-v4-pro",
      route: "OpenRouter",
      input_per_1m_usd: 1.32,
      output_per_1m_usd: 3.96,
      cache_read_per_1m_usd: null,
      cache_write_per_1m_usd: null,
      has_conditional_pricing: false,
    };
    const oldSource = {
      id: "openrouter" as const,
      name: "OpenRouter",
      source_url: "https://openrouter.ai/api/v1/models",
      fetched_at: "2026-10-10T00:00:00.000Z",
      last_successful_at: "2026-10-10T00:00:00.000Z",
      ok: true,
      status: 200,
      error: null,
      etag: null,
      model_rates: [oldRate],
    };

    const sources = await fetchAggregatorPricingSources([oldSource]);
    const openrouter = sources.find((source) => source.id === "openrouter");

    expect(openrouter).toMatchObject({
      ok: false,
      status: 403,
      last_successful_at: "2026-10-10T00:00:00.000Z",
      model_rates: [oldRate],
    });
  });
});