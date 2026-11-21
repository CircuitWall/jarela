import { describe, expect, it } from "vitest";
import { DEFAULT_STT_ENGINE, STT_ENGINES, isSttEngine, normalizeSttEngine, sttEngineLabel } from "./types";

describe("stt engine vocabulary", () => {
  it("keeps gemini as the default so stored agents behave as before", () => {
    expect(DEFAULT_STT_ENGINE).toBe("gemini");
    expect(normalizeSttEngine(undefined)).toBe("gemini");
    expect(normalizeSttEngine(null)).toBe("gemini");
    expect(normalizeSttEngine("")).toBe("gemini");
    expect(normalizeSttEngine("sphinx")).toBe("gemini");
    expect(normalizeSttEngine(7)).toBe("gemini");
  });

  it("accepts every declared engine", () => {
    for (const engine of STT_ENGINES) {
      expect(isSttEngine(engine)).toBe(true);
      expect(normalizeSttEngine(engine)).toBe(engine);
      expect(sttEngineLabel(engine).length).toBeGreaterThan(0);
    }
  });

  it("rejects lookalike values", () => {
    expect(isSttEngine("Browser")).toBe(false);
    expect(isSttEngine("whisper ")).toBe(false);
  });
});
