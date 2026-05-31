import { describe, expect, it } from "vitest";
import { __testing } from "./llm-extract";

const { readEnvelope, normalizeRate, normalizeRow, preparePageForLlm } = __testing;

describe("llm-extract helpers", () => {
  describe("readEnvelope", () => {
    it("parses a bare JSON object", () => {
      const env = readEnvelope('{"models":[{"model_id":"gpt-4o"}]}');
      expect(env?.models?.[0]?.model_id).toBe("gpt-4o");
    });

    it("strips markdown fences before parsing", () => {
      const env = readEnvelope('```json\n{"models":[]}\n```');
      expect(env?.models).toEqual([]);
    });

    it("extracts the first balanced object when prose surrounds it", () => {
      const env = readEnvelope('Here you go:\n{"models":[]}\nThanks.');
      expect(env?.models).toEqual([]);
    });

    it("returns null on unparseable text", () => {
      expect(readEnvelope("not json")).toBeNull();
      expect(readEnvelope(null)).toBeNull();
    });
  });

  describe("normalizeRate", () => {
    it("returns finite non-negative numbers as-is", () => {
      expect(normalizeRate(2.5)).toBe(2.5);
      expect(normalizeRate(0)).toBe(0);
    });

    it("rejects null, undefined, negative, NaN", () => {
      expect(normalizeRate(null)).toBeNull();
      expect(normalizeRate(undefined)).toBeNull();
      expect(normalizeRate(-1)).toBeNull();
      expect(normalizeRate(Number.NaN)).toBeNull();
    });

    it("rejects implausibly large values (likely unit confusion)", () => {
      expect(normalizeRate(1500)).toBeNull();
      expect(normalizeRate(1000.01)).toBeNull();
      expect(normalizeRate(999)).toBe(999);
    });
  });

  describe("normalizeRow", () => {
    it("normalizes a full row", () => {
      const row = normalizeRow({
        model_id: "  GPT-4O  ",
        input_per_1m_usd: 5,
        output_per_1m_usd: 15,
        inferred: false,
        confidence: "high",
      });
      expect(row).toEqual({
        model_id: "gpt-4o",
        input_per_1m_usd: 5,
        output_per_1m_usd: 15,
        inferred: false,
        confidence: "high",
      });
    });

    it("defaults inferred=true and confidence=low on unknown values", () => {
      const row = normalizeRow({
        model_id: "x",
        input_per_1m_usd: 1,
        confidence: "wild",
      });
      expect(row?.inferred).toBe(true);
      expect(row?.confidence).toBe("low");
    });

    it("rejects rows with no model_id or no rates", () => {
      expect(normalizeRow({ model_id: "", input_per_1m_usd: 1 })).toBeNull();
      expect(normalizeRow({ model_id: "x" })).toBeNull();
      expect(normalizeRow(null)).toBeNull();
    });
  });

  describe("preparePageForLlm", () => {
    it("strips scripts/styles/tags and collapses whitespace", () => {
      const html = "<html><script>bad()</script><style>x{}</style><div>gpt-4o $5 /\n1M</div></html>";
      expect(preparePageForLlm(html)).toBe("gpt-4o $5 / 1M");
    });

    it("truncates very long input", () => {
      const long = "a".repeat(30_000);
      const out = preparePageForLlm(`<p>${long}</p>`);
      expect(out.length).toBe(24_000);
    });
  });
});
