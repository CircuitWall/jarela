import { describe, expect, it } from "vitest";
import { parseHexColor, withAlpha } from "./color";

describe("parseHexColor", () => {
  it("parses 6-digit hex", () => {
    expect(parseHexColor("#22c55e")).toEqual([0x22, 0xc5, 0x5e]);
  });
  it("parses 3-digit hex by expanding nibbles", () => {
    expect(parseHexColor("#abc")).toEqual([0xaa, 0xbb, 0xcc]);
  });
  it("accepts upper-case hex", () => {
    expect(parseHexColor("#FFFFFF")).toEqual([255, 255, 255]);
  });
  it("trims whitespace", () => {
    expect(parseHexColor("  #000000  ")).toEqual([0, 0, 0]);
  });
  it("rejects missing hash", () => {
    expect(parseHexColor("22c55e")).toBeNull();
  });
  it("rejects bogus characters", () => {
    expect(parseHexColor("#zzzzzz")).toBeNull();
  });
  it("rejects 4 or 5 digit hex", () => {
    expect(parseHexColor("#1234")).toBeNull();
    expect(parseHexColor("#12345")).toBeNull();
  });
});

describe("withAlpha", () => {
  it("emits rgba from a hex color", () => {
    expect(withAlpha("#22c55e", 0.5)).toBe("rgba(34, 197, 94, 0.5)");
  });
  it("clamps alpha to [0,1]", () => {
    expect(withAlpha("#22c55e", -1)).toBe("rgba(34, 197, 94, 0)");
    expect(withAlpha("#22c55e", 5)).toBe("rgba(34, 197, 94, 1)");
  });
  it("falls back to brand green when hex is invalid", () => {
    expect(withAlpha("nope", 0.25)).toBe("rgba(34, 197, 94, 0.25)");
  });
});
