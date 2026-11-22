import { describe, expect, it } from "vitest";
import { NEUTRAL_PROSODY, browserProsody } from "./prosody";

describe("browserProsody", () => {
  it("stays neutral without a note", () => {
    expect(browserProsody(null)).toEqual(NEUTRAL_PROSODY);
    expect(browserProsody("  ")).toEqual(NEUTRAL_PROSODY);
  });

  it("softens a whisper note", () => {
    const prosody = browserProsody("whisper conspiratorially");
    expect(prosody.volume).toBeLessThan(0.5);
    expect(prosody.rate).toBeLessThan(1);
  });

  it("maps warm and reassuring to a slower, lower delivery", () => {
    expect(browserProsody("warm and reassuring")).toEqual({ rate: 0.92, pitch: 0.96, volume: 1 });
  });

  it("lifts an excited note", () => {
    const prosody = browserProsody("cheerful and excited");
    expect(prosody.rate).toBeGreaterThan(1);
    expect(prosody.pitch).toBeGreaterThan(1);
  });

  it("drops pitch for a serious note", () => {
    expect(browserProsody("serious").pitch).toBeLessThan(1);
  });

  it("slows a careful note", () => {
    expect(browserProsody("slow and careful").rate).toBeLessThan(0.9);
  });

  it("reads an unsupported note plainly instead of guessing", () => {
    expect(browserProsody("brisk and matter-of-fact")).toEqual(NEUTRAL_PROSODY);
  });
});
