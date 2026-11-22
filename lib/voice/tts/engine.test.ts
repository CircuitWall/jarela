import { describe, expect, it } from "vitest";
import { resolveReplyTtsEngine } from "./engine";

describe("resolveReplyTtsEngine", () => {
  it("keeps Gemini TTS for Gemini input and the default", () => {
    expect(resolveReplyTtsEngine("gemini")).toBe("gemini");
    expect(resolveReplyTtsEngine(null)).toBe("gemini");
    expect(resolveReplyTtsEngine(undefined)).toBe("gemini");
  });

  it("uses browser voices for browser and Whisper input", () => {
    expect(resolveReplyTtsEngine("browser")).toBe("browser");
    // Whisper is recognition-only; it cannot synthesize.
    expect(resolveReplyTtsEngine("whisper")).toBe("browser");
  });
});
