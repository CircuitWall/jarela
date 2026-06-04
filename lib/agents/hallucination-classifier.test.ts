import { describe, it, expect } from "vitest";
import { parseVerdict } from "./hallucination-classifier";

describe("parseVerdict", () => {
  it("parses a clean JSON verdict", () => {
    expect(parseVerdict('{"stalled": true, "reason": "no write tool called"}'))
      .toEqual({ stalled: true, reason: "no write tool called" });
  });

  it("parses stalled=false", () => {
    expect(parseVerdict('{"stalled": false, "reason": "tool ran"}'))
      .toEqual({ stalled: false, reason: "tool ran" });
  });

  it("strips a markdown code fence wrapping", () => {
    const wrapped = '```json\n{"stalled": true, "reason": "ok"}\n```';
    expect(parseVerdict(wrapped)).toEqual({ stalled: true, reason: "ok" });
  });

  it("extracts the verdict object even with surrounding prose", () => {
    const noisy = 'The model responded: {"stalled": true, "reason": "narration only"} — done.';
    expect(parseVerdict(noisy)).toEqual({ stalled: true, reason: "narration only" });
  });

  it("returns null on empty / whitespace input", () => {
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict("   ")).toBeNull();
  });

  it("returns null when the JSON is malformed", () => {
    expect(parseVerdict('{"stalled": true,')).toBeNull();
    expect(parseVerdict("not json at all")).toBeNull();
  });

  it("returns null when stalled is not a boolean", () => {
    expect(parseVerdict('{"stalled": "yes", "reason": "stringly"}')).toBeNull();
    expect(parseVerdict('{"stalled": 1, "reason": "numbery"}')).toBeNull();
  });

  it("tolerates missing reason (uses empty string)", () => {
    expect(parseVerdict('{"stalled": true}')).toEqual({ stalled: true, reason: "" });
  });

  it("trims a long reason to 200 chars", () => {
    const longReason = "x".repeat(500);
    const r = parseVerdict(`{"stalled": false, "reason": "${longReason}"}`);
    expect(r?.reason.length).toBe(200);
  });

  it("ignores extra unknown fields", () => {
    expect(parseVerdict('{"stalled": true, "reason": "ok", "confidence": 0.7}'))
      .toEqual({ stalled: true, reason: "ok" });
  });
});
