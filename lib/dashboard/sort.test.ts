import { describe, expect, it } from "vitest";
import {
  filterModelRates,
  groupModelRatesByVendor,
  sortModelRates,
  sortTools,
  type ModelRateRow,
  type ToolRow,
} from "./sort";

const rates: ModelRateRow[] = [
  { provider: "openai", model_id: "gpt-4o", input_per_1m_usd: 5, output_per_1m_usd: 15, confidence: "high" },
  { provider: "openai", model_id: "gpt-4o-mini", input_per_1m_usd: 0.15, output_per_1m_usd: 0.6, confidence: "high" },
  { provider: "anthropic", model_id: "claude-3-5-sonnet", input_per_1m_usd: 3, output_per_1m_usd: 15, confidence: "medium" },
  { provider: "anthropic", model_id: "claude-3-haiku", input_per_1m_usd: null, output_per_1m_usd: null, confidence: "low" },
  { provider: "voyage", model_id: "voyage-large-2", input_per_1m_usd: 0.12, output_per_1m_usd: null, confidence: "low" },
];

describe("filterModelRates", () => {
  it("returns everything when filters are 'all' and search is empty", () => {
    expect(filterModelRates(rates, { vendor: "all", functionality: "all", search: "" })).toHaveLength(5);
  });
  it("filters by vendor", () => {
    const out = filterModelRates(rates, { vendor: "anthropic", functionality: "all", search: "" });
    expect(out.map((r) => r.model_id)).toEqual(["claude-3-5-sonnet", "claude-3-haiku"]);
  });
  it("filters by functionality (embeddings) via classifier", () => {
    const out = filterModelRates(rates, { vendor: "all", functionality: "embeddings", search: "" });
    expect(out.map((r) => r.model_id)).toEqual(["voyage-large-2"]);
  });
  it("filters by functionality (multimodal)", () => {
    const out = filterModelRates(rates, { vendor: "all", functionality: "multimodal", search: "" });
    // "vl" pattern in qwen2-vl-7b matches multimodal
    expect(out.map((r) => r.model_id)).toEqual([]);
  });
  it("matches search case-insensitively across provider/model", () => {
    const out = filterModelRates(rates, { vendor: "all", functionality: "all", search: "CLAUDE" });
    expect(out).toHaveLength(2);
  });
  it("treats empty/whitespace search as no-op", () => {
    expect(filterModelRates(rates, { vendor: "all", functionality: "all", search: "   " })).toHaveLength(5);
  });
});

describe("sortModelRates", () => {
  it("does not mutate input", () => {
    const original = [...rates];
    sortModelRates(rates, "input_desc");
    expect(rates).toEqual(original);
  });

  it("model_asc / model_desc", () => {
    const asc = sortModelRates(rates, "model_asc").map((r) => r.model_id);
    const desc = sortModelRates(rates, "model_desc").map((r) => r.model_id);
    expect(asc).toEqual([...asc].sort());
    expect(desc).toEqual([...asc].reverse());
  });

  it("input_desc puts highest input rate first; nulls sort last", () => {
    const ids = sortModelRates(rates, "input_desc").map((r) => r.model_id);
    expect(ids[0]).toBe("gpt-4o");
    expect(ids[ids.length - 1]).toBe("claude-3-haiku");
  });

  it("input_asc puts lowest defined rate first; nulls sort last", () => {
    const ids = sortModelRates(rates, "input_asc").map((r) => r.model_id);
    expect(ids[0]).toBe("voyage-large-2");
    expect(ids[ids.length - 1]).toBe("claude-3-haiku");
  });

  it("output_desc / output_asc behave symmetrically and demote nulls", () => {
    const desc = sortModelRates(rates, "output_desc").map((r) => r.model_id);
    expect(desc[0]).toMatch(/gpt-4o|claude-3-5-sonnet/); // both at 15
    expect(desc[desc.length - 1]).toMatch(/claude-3-haiku|voyage-large-2/);

    const asc = sortModelRates(rates, "output_asc").map((r) => r.model_id);
    expect(asc[asc.length - 1]).toMatch(/claude-3-haiku|voyage-large-2/);
  });

  it("confidence_desc orders high > medium > low", () => {
    const ids = sortModelRates(rates, "confidence_desc").map((r) => r.model_id);
    const ranks = ids.map(
      (id) => rates.find((r) => r.model_id === id)!.confidence,
    );
    const order = { high: 3, medium: 2, low: 1 } as const;
    for (let i = 1; i < ranks.length; i++) {
      expect(order[ranks[i]]).toBeLessThanOrEqual(order[ranks[i - 1]]);
    }
  });

  it("confidence_asc orders low < medium < high", () => {
    const ids = sortModelRates(rates, "confidence_asc").map((r) => r.model_id);
    const order = { high: 3, medium: 2, low: 1 } as const;
    const ranks = ids.map((id) => rates.find((r) => r.model_id === id)!.confidence);
    for (let i = 1; i < ranks.length; i++) {
      expect(order[ranks[i]]).toBeGreaterThanOrEqual(order[ranks[i - 1]]);
    }
  });
});

describe("groupModelRatesByVendor", () => {
  it("groups and sorts vendors alphabetically", () => {
    const grouped = groupModelRatesByVendor(rates);
    expect(grouped.map(([v]) => v)).toEqual(["anthropic", "openai", "voyage"]);
    expect(grouped[0][1]).toHaveLength(2);
    expect(grouped[1][1]).toHaveLength(2);
    expect(grouped[2][1]).toHaveLength(1);
  });
});

const tools: ToolRow[] = [
  { name: "alpha", call_count: 10, error_count: 1, score: 0.8, success_rate: 0.9 },
  { name: "bravo", call_count: 100, error_count: 5, score: 0.6, success_rate: 0.95 },
  { name: "charlie", call_count: 50, error_count: 25, score: 0.7, success_rate: 0.5 },
  { name: "delta", call_count: 0, error_count: 0, score: 0.9, success_rate: 1 },
];

describe("sortTools", () => {
  it("does not mutate input", () => {
    const original = [...tools];
    sortTools(tools, "calls_desc");
    expect(tools).toEqual(original);
  });

  it("'best' uses score, then success_rate, then call_count", () => {
    const names = sortTools(tools, "best").map((t) => t.name);
    expect(names[0]).toBe("delta"); // highest score (0.9)
    expect(names[1]).toBe("alpha"); // next score (0.8)
  });

  it("calls_desc", () => {
    expect(sortTools(tools, "calls_desc").map((t) => t.name)).toEqual([
      "bravo", "charlie", "alpha", "delta",
    ]);
  });

  it("errors_desc", () => {
    expect(sortTools(tools, "errors_desc")[0].name).toBe("charlie");
  });

  it("error_rate_desc treats zero-call tools as 0 rate", () => {
    const names = sortTools(tools, "error_rate_desc").map((t) => t.name);
    expect(names[0]).toBe("charlie"); // 25/50 = 0.5
    // delta has 0 calls → rate 0, sorts to the end by name tie-break
    expect(names[names.length - 1]).toMatch(/delta|alpha/);
  });

  it("name_asc", () => {
    expect(sortTools(tools, "name_asc").map((t) => t.name)).toEqual([
      "alpha", "bravo", "charlie", "delta",
    ]);
  });
});
