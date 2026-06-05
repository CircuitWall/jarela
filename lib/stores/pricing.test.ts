import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPricingTables,
  providerRatesFor,
  modelRatesFor,
  estimateCostUsd,
  normalizeProvider,
} from "./pricing";

// pricing.ts reads docs/journal/pricing-snapshot.json relative to process.cwd().
// Each test seeds a fresh tmpdir, chdir's into it, and writes a tailored
// snapshot. afterEach restores the previous cwd and removes the tmpdir.
let prevCwd: string;
let tmpRoot: string;

function seedSnapshot(snapshot: unknown) {
  const journal = join(tmpRoot, "docs", "journal");
  mkdirSync(journal, { recursive: true });
  writeFileSync(join(journal, "pricing-snapshot.json"), JSON.stringify(snapshot));
}

beforeEach(() => {
  prevCwd = process.cwd();
  tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-pricing-"));
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(prevCwd);
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("normalizeProvider", () => {
  it.each([
    ["openai", "openai"],
    ["OpenAI", "openai"],
    ["openai-chat", "openai"],
    ["anthropic", "anthropic"],
    ["Anthropic Claude", "anthropic"],
    ["google", "google"],
    ["Gemini Pro", "google"],
    ["github", "github-copilot"],
    ["GitHub Copilot", "github-copilot"],
    ["copilot", "github-copilot"],
    ["cohere", "cohere"],
    ["DeepSeek", "deepseek"],
  ])("normalizes %s -> %s", (input, expected) => {
    expect(normalizeProvider(input)).toBe(expected);
  });

  it("returns the lowercased input for unknown providers", () => {
    expect(normalizeProvider("Mistral")).toBe("mistral");
  });

  it("returns null for empty string", () => {
    expect(normalizeProvider("")).toBeNull();
  });
});

describe("estimateCostUsd", () => {
  it("returns 0 when both rates are null", () => {
    expect(estimateCostUsd(1000, 500, { inputPer1M: null, outputPer1M: null })).toBe(0);
  });

  it("computes input-only when output rate is null", () => {
    expect(estimateCostUsd(1_000_000, 500_000, { inputPer1M: 2, outputPer1M: null })).toBe(2);
  });

  it("computes output-only when input rate is null", () => {
    expect(estimateCostUsd(1_000_000, 1_000_000, { inputPer1M: null, outputPer1M: 5 })).toBe(5);
  });

  it("sums input + output costs", () => {
    expect(estimateCostUsd(1_000_000, 1_000_000, { inputPer1M: 3, outputPer1M: 9 })).toBe(12);
  });

  it("scales sub-million token counts proportionally", () => {
    expect(estimateCostUsd(500_000, 100_000, { inputPer1M: 2, outputPer1M: 10 })).toBeCloseTo(2, 6);
  });

  describe("anthropic prompt-cache pricing", () => {
    const rates = { inputPer1M: 3, outputPer1M: 15 };

    it("ignores cache breakdown when not provided", () => {
      // Sanity: existing call signature unchanged.
      expect(estimateCostUsd(1_000_000, 0, rates)).toBe(3);
    });

    it("prices cache writes at 1.25× the input rate", () => {
      // 1M cache_creation tokens × $3/M × 1.25 = $3.75
      expect(
        estimateCostUsd(0, 0, rates, { cache_creation_input_tokens: 1_000_000 }),
      ).toBeCloseTo(3.75, 6);
    });

    it("prices cache reads at 0.1× the input rate", () => {
      // 1M cache_read tokens × $3/M × 0.1 = $0.30
      expect(
        estimateCostUsd(0, 0, rates, { cache_read_input_tokens: 1_000_000 }),
      ).toBeCloseTo(0.3, 6);
    });

    it("sums fresh + cache_creation + cache_read + output (Anthropic-style turn)", () => {
      // 100k fresh input ($0.30) + 50k cache_creation ($0.1875)
      // + 800k cache_read ($0.24) + 20k output ($0.30) = $1.0275
      const cost = estimateCostUsd(100_000, 20_000, rates, {
        cache_creation_input_tokens: 50_000,
        cache_read_input_tokens: 800_000,
      });
      expect(cost).toBeCloseTo(0.3 + 0.1875 + 0.24 + 0.3, 6);
    });

    it("does not double-bill cache when input rate is null", () => {
      // No input rate → cache multipliers have nothing to multiply against.
      expect(
        estimateCostUsd(0, 100_000, { inputPer1M: null, outputPer1M: 5 }, {
          cache_creation_input_tokens: 1_000_000,
          cache_read_input_tokens: 1_000_000,
        }),
      ).toBeCloseTo(0.5, 6);
    });

    it("treats nullish cache fields as zero", () => {
      expect(
        estimateCostUsd(0, 0, rates, {
          cache_creation_input_tokens: null,
          cache_read_input_tokens: undefined,
        }),
      ).toBe(0);
    });
  });
});

describe("getPricingTables", () => {
  it("returns null-rate sentinels for every expected provider when snapshot is missing", () => {
    const tables = getPricingTables();
    for (const p of ["openai", "anthropic", "google", "deepseek", "cohere", "github-copilot"]) {
      const r = tables.byProvider.get(p);
      expect(r).toBeDefined();
      expect(r!.inputPer1M).toBeNull();
      expect(r!.outputPer1M).toBeNull();
      expect(r!.ok).toBe(false);
      expect(r!.source).toBe("snapshot-missing");
    }
    expect(tables.generatedAt).toBeNull();
  });

  it("returns null-rate sentinels when snapshot file is malformed JSON", () => {
    const journal = join(tmpRoot, "docs", "journal");
    mkdirSync(journal, { recursive: true });
    writeFileSync(join(journal, "pricing-snapshot.json"), "not valid json");
    const tables = getPricingTables();
    expect(tables.byProvider.get("openai")!.inputPer1M).toBeNull();
  });

  it("populates per-provider rates from price_signals", () => {
    seedSnapshot({
      generated_at: "2026-06-01T00:00:00Z",
      sources: [{
        id: "openai",
        pricing_url: "https://openai.com/pricing",
        ok: true,
        status: 200,
        price_signals: ["$3/1M tokens", "$15/1M tokens"],
      }],
    });
    const tables = getPricingTables();
    const r = tables.byProvider.get("openai")!;
    expect(r.inputPer1M).toBe(3);
    expect(r.outputPer1M).toBe(15);
    expect(r.confidence).toBe("medium");
    expect(r.inferred).toBe(true);
    expect(r.ok).toBe(true);
    expect(tables.generatedAt).toBe("2026-06-01T00:00:00Z");
  });

  it("falls back to model_rates when price_signals are missing", () => {
    seedSnapshot({
      sources: [{
        id: "anthropic",
        pricing_url: "https://anthropic.com",
        ok: true,
        status: 200,
        model_rates: [
          { model_id: "claude-3-haiku", input_per_1m_usd: 0.25, output_per_1m_usd: 1.25 },
          { model_id: "claude-3-opus", input_per_1m_usd: 15, output_per_1m_usd: 75 },
        ],
      }],
    });
    const tables = getPricingTables();
    const r = tables.byProvider.get("anthropic")!;
    expect(r.inputPer1M).toBe(0.25);
    expect(r.outputPer1M).toBe(1.25);
    expect(r.confidence).toBe("medium");
  });

  it("populates per-model rates", () => {
    seedSnapshot({
      sources: [{
        id: "openai",
        pricing_url: "https://openai.com",
        model_rates: [
          { model_id: "gpt-4o", input_per_1m_usd: 5, output_per_1m_usd: 15, confidence: "high" },
        ],
      }],
    });
    const tables = getPricingTables();
    const r = tables.byProviderModel.get("openai::gpt-4o");
    expect(r).toBeDefined();
    expect(r!.inputPer1M).toBe(5);
    expect(r!.outputPer1M).toBe(15);
    expect(r!.confidence).toBe("high");
  });

  it("skips model_rates with empty model_id", () => {
    seedSnapshot({
      sources: [{
        id: "openai",
        pricing_url: "https://openai.com",
        model_rates: [
          { model_id: "", input_per_1m_usd: 1, output_per_1m_usd: 2 },
          { model_id: "gpt-4", input_per_1m_usd: 5, output_per_1m_usd: 15 },
        ],
      }],
    });
    const tables = getPricingTables();
    expect(tables.byProviderModel.get("openai::gpt-4")).toBeDefined();
    expect(tables.byProviderModel.get("openai::")).toBeUndefined();
  });

  it("ignores sources with unrecognised id (no key produced)", () => {
    // normalizeProvider on a non-empty string never returns null, so this
    // exercises the path where the entry is just the lowercased name.
    seedSnapshot({
      sources: [{ id: "weirdco", pricing_url: "https://x", price_signals: ["$1/1M tokens"] }],
    });
    const tables = getPricingTables();
    expect(tables.byProvider.get("weirdco")!.inputPer1M).toBe(1);
  });
});

describe("providerRatesFor", () => {
  it("returns 'no provider assigned' when provider is null", () => {
    const tables = getPricingTables();
    const r = providerRatesFor(tables, null);
    expect(r.error).toBe("no provider assigned");
    expect(r.ok).toBe(false);
  });

  it("returns the table entry for a known provider", () => {
    seedSnapshot({
      sources: [{ id: "openai", pricing_url: "https://x", price_signals: ["$2/1M tokens"] }],
    });
    const tables = getPricingTables();
    expect(providerRatesFor(tables, "openai").inputPer1M).toBe(2);
  });

  it("normalizes case before lookup", () => {
    seedSnapshot({
      sources: [{ id: "openai", pricing_url: "https://x", price_signals: ["$2/1M tokens"] }],
    });
    const tables = getPricingTables();
    expect(providerRatesFor(tables, "OpenAI").inputPer1M).toBe(2);
  });

  it("returns sentinel when provider is missing from the snapshot", () => {
    seedSnapshot({ sources: [] });
    const tables = getPricingTables();
    const r = providerRatesFor(tables, "made-up");
    expect(r.inputPer1M).toBeNull();
    expect(r.error).toContain("missing");
  });
});

describe("modelRatesFor", () => {
  it("returns provider-level rates when modelId is null", () => {
    seedSnapshot({
      sources: [{ id: "openai", pricing_url: "https://x", price_signals: ["$2/1M tokens"] }],
    });
    const tables = getPricingTables();
    expect(modelRatesFor(tables, "openai", null).inputPer1M).toBe(2);
  });

  it("returns provider-level rates when provider is null and the model is unknown", () => {
    const tables = getPricingTables();
    expect(modelRatesFor(tables, null, "made-up-model").error).toBe("no provider assigned");
  });

  it("falls through to known-rates even when provider is null, if the id is canonical", () => {
    // Behavior change with the known-rates tier: a null provider no longer
    // implies "give up" — if we authoritatively know the model, we price it.
    const tables = getPricingTables();
    const rates = modelRatesFor(tables, null, "gpt-4o");
    expect(rates.inputPer1M).toBe(2.5);
    expect(rates.outputPer1M).toBe(10);
    expect(rates.source).toBe("jarela:known-rates");
  });

  it("returns exact-match per-model rates when present", () => {
    seedSnapshot({
      sources: [{
        id: "openai",
        pricing_url: "https://x",
        model_rates: [
          { model_id: "gpt-4o", input_per_1m_usd: 5, output_per_1m_usd: 15 },
        ],
      }],
    });
    const tables = getPricingTables();
    expect(modelRatesFor(tables, "openai", "gpt-4o").inputPer1M).toBe(5);
  });

  it("falls back to provider-level rates for unknown models", () => {
    seedSnapshot({
      sources: [{
        id: "openai",
        pricing_url: "https://x",
        price_signals: ["$2/1M tokens"],
        model_rates: [
          { model_id: "gpt-4o", input_per_1m_usd: 5, output_per_1m_usd: 15 },
        ],
      }],
    });
    const tables = getPricingTables();
    expect(modelRatesFor(tables, "openai", "made-up-model").inputPer1M).toBe(2);
  });

  it("matches deepseek-reasoner aliases via 'r1' / 'reasoner'", () => {
    seedSnapshot({
      sources: [{
        id: "deepseek",
        pricing_url: "https://x",
        model_rates: [
          { model_id: "deepseek-reasoner", input_per_1m_usd: 0.55, output_per_1m_usd: 2.19 },
        ],
      }],
    });
    const tables = getPricingTables();
    expect(modelRatesFor(tables, "deepseek", "r1-distill").inputPer1M).toBe(0.55);
    expect(modelRatesFor(tables, "deepseek", "deepseek-reasoner-v2").inputPer1M).toBe(0.55);
  });

  it("matches deepseek-chat aliases via 'chat' / 'v3' / 'coder'", () => {
    seedSnapshot({
      sources: [{
        id: "deepseek",
        pricing_url: "https://x",
        model_rates: [
          { model_id: "deepseek-chat", input_per_1m_usd: 0.27, output_per_1m_usd: 1.10 },
        ],
      }],
    });
    const tables = getPricingTables();
    expect(modelRatesFor(tables, "deepseek", "deepseek-coder").inputPer1M).toBe(0.27);
    expect(modelRatesFor(tables, "deepseek", "deepseek-v3").inputPer1M).toBe(0.27);
    expect(modelRatesFor(tables, "deepseek", "ds-chat-x").inputPer1M).toBe(0.27);
  });

  describe("github-copilot upstream inference", () => {
    it("infers OpenAI rates for gpt-* model ids", () => {
      seedSnapshot({
        sources: [
          { id: "github-copilot", pricing_url: "https://x", ok: true },
          {
            id: "openai", pricing_url: "https://y",
            model_rates: [{ model_id: "gpt-4o", input_per_1m_usd: 5, output_per_1m_usd: 15 }],
          },
        ],
      });
      const tables = getPricingTables();
      expect(modelRatesFor(tables, "github-copilot", "gpt-4o").inputPer1M).toBe(5);
    });

    it("infers OpenAI rates for o1/o2/o3 reasoning model ids", () => {
      seedSnapshot({
        sources: [
          { id: "github-copilot", pricing_url: "https://x", ok: true },
          {
            id: "openai", pricing_url: "https://y",
            price_signals: ["$3/1M tokens"],
          },
        ],
      });
      const tables = getPricingTables();
      expect(modelRatesFor(tables, "github-copilot", "o1-preview").inputPer1M).toBe(3);
    });

    it("infers Anthropic rates for claude-* model ids", () => {
      seedSnapshot({
        sources: [
          { id: "github-copilot", pricing_url: "https://x", ok: true },
          {
            id: "anthropic", pricing_url: "https://y",
            model_rates: [{ model_id: "claude-3-5-sonnet", input_per_1m_usd: 3, output_per_1m_usd: 15 }],
          },
        ],
      });
      const tables = getPricingTables();
      expect(modelRatesFor(tables, "github-copilot", "claude-3-5-sonnet").inputPer1M).toBe(3);
    });

    it("infers Google rates for gemini-* model ids", () => {
      seedSnapshot({
        sources: [
          { id: "github-copilot", pricing_url: "https://x", ok: true },
          {
            id: "google", pricing_url: "https://y",
            price_signals: ["$1.25/1M tokens"],
          },
        ],
      });
      const tables = getPricingTables();
      expect(modelRatesFor(tables, "github-copilot", "gemini-2-flash").inputPer1M).toBe(1.25);
    });

    it("infers DeepSeek rates for deepseek-* model ids", () => {
      seedSnapshot({
        sources: [
          { id: "github-copilot", pricing_url: "https://x", ok: true },
          {
            id: "deepseek", pricing_url: "https://y",
            price_signals: ["$0.27/1M tokens"],
          },
        ],
      });
      const tables = getPricingTables();
      expect(modelRatesFor(tables, "github-copilot", "deepseek-chat").inputPer1M).toBe(0.27);
    });

    it("infers Cohere rates for command-* / embed-* model ids", () => {
      seedSnapshot({
        sources: [
          { id: "github-copilot", pricing_url: "https://x", ok: true },
          {
            id: "cohere", pricing_url: "https://y",
            price_signals: ["$0.4/1M tokens"],
          },
        ],
      });
      const tables = getPricingTables();
      expect(modelRatesFor(tables, "github-copilot", "command-r-plus").inputPer1M).toBe(0.4);
    });

    it("falls back to provider-level when model id has no recognisable prefix", () => {
      seedSnapshot({
        sources: [{ id: "github-copilot", pricing_url: "https://x", ok: true, price_signals: ["$2/1M tokens"] }],
      });
      const tables = getPricingTables();
      expect(modelRatesFor(tables, "github-copilot", "unknown-model").inputPer1M).toBe(2);
    });
  });

  describe("aggregator-agnostic model_id fallback", () => {
    it("resolves by model id alone when the configured provider has no per-model rate", () => {
      seedSnapshot({
        sources: [
          { id: "openrouter", pricing_url: "https://x", ok: true },
          {
            id: "anthropic",
            pricing_url: "https://y",
            ok: true,
            model_rates: [{ model_id: "claude-opus-4-7", input_per_1m_usd: 15, output_per_1m_usd: 75 }],
          },
        ],
      });
      const tables = getPricingTables();
      // openrouter is unknown to normalizeProvider and exposes no per-model
      // rate; the lookup must still resolve via the byModel index using the
      // anthropic-published rate for the same id.
      const rates = modelRatesFor(tables, "openrouter", "claude-opus-4-7");
      expect(rates.inputPer1M).toBe(15);
      expect(rates.outputPer1M).toBe(75);
    });

    it("returns model_id-only hit when provider is null", () => {
      seedSnapshot({
        sources: [
          {
            id: "anthropic",
            pricing_url: "https://x",
            ok: true,
            model_rates: [{ model_id: "claude-sonnet-4-6", input_per_1m_usd: 3, output_per_1m_usd: 15 }],
          },
        ],
      });
      const tables = getPricingTables();
      const rates = modelRatesFor(tables, null, "claude-sonnet-4-6");
      expect(rates.inputPer1M).toBe(3);
      expect(rates.outputPer1M).toBe(15);
    });

    it("strips aggregator path prefix to match the bare model id", () => {
      seedSnapshot({
        sources: [
          { id: "openrouter", pricing_url: "https://x", ok: true },
          {
            id: "openai",
            pricing_url: "https://y",
            ok: true,
            model_rates: [{ model_id: "gpt-4o", input_per_1m_usd: 5, output_per_1m_usd: 15 }],
          },
        ],
      });
      const tables = getPricingTables();
      // OpenRouter-style namespacing: `vendor/model` and `aggregator/vendor/model`
      // both resolve via the bare `gpt-4o` rate published by OpenAI.
      expect(modelRatesFor(tables, "openrouter", "openai/gpt-4o").inputPer1M).toBe(5);
      expect(modelRatesFor(tables, "openrouter", "openrouter/openai/gpt-4o").inputPer1M).toBe(5);
    });

    it("strips aggregator prefix when inferring upstream for github-copilot", () => {
      seedSnapshot({
        sources: [
          { id: "github-copilot", pricing_url: "https://x", ok: true },
          {
            id: "openai",
            pricing_url: "https://y",
            ok: true,
            model_rates: [{ model_id: "gpt-4o", input_per_1m_usd: 5, output_per_1m_usd: 15 }],
          },
        ],
      });
      const tables = getPricingTables();
      expect(modelRatesFor(tables, "github-copilot", "openai/gpt-4o").inputPer1M).toBe(5);
    });
  });

  describe("known-rates fallback (final tier)", () => {
    it("resolves canonical ids when the snapshot has no anthropic model_rates", () => {
      // Repro: an internal proxy with model_id=claude-opus-4-7 +
      // an anthropic source that fetched OK but produced zero
      // model_rates (regex extractor lost the model names). Without
      // the known-rates tier this fell through to a null provider rate.
      seedSnapshot({
        sources: [
          {
            id: "anthropic",
            pricing_url: "https://x",
            ok: true,
            status: 200,
            price_signals: ["Input $ 3 / MTok", "Output $ 15 / MTok"],
            model_rates: [],
          },
        ],
      });
      const tables = getPricingTables();
      const rates = modelRatesFor(tables, "internal-proxy", "claude-opus-4-7");
      expect(rates.inputPer1M).toBeGreaterThan(0);
      expect(rates.outputPer1M).toBeGreaterThan(0);
      expect(rates.source).toBe("jarela:known-rates");
    });
  });
});
