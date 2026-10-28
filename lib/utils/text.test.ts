import { describe, it, expect } from "vitest";
import { truncateBytes, truncateText } from "./text";

describe("truncateBytes", () => {
  it("returns the original string under the cap", () => {
    expect(truncateBytes("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  it("returns the original string at exact cap", () => {
    expect(truncateBytes("12345", 5)).toEqual({ text: "12345", truncated: false });
  });

  it("truncates and flags when over cap (ASCII)", () => {
    expect(truncateBytes("abcdefghij", 4)).toEqual({ text: "abcd", truncated: true });
  });

  it("counts bytes, not characters (multibyte unicode)", () => {
    // Each emoji is 4 UTF-8 bytes. With a 4-byte cap we keep exactly one.
    const out = truncateBytes("😀😀😀", 4);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.text, "utf8")).toBeLessThanOrEqual(4);
  });

  it("never produces output exceeding the byte budget", () => {
    // Mix ASCII + multibyte; ensure we never exceed the budget by even a byte.
    const out = truncateBytes("abc😀def", 5);
    expect(Buffer.byteLength(out.text, "utf8")).toBeLessThanOrEqual(5);
    expect(out.truncated).toBe(true);
  });

  it("does not split a surrogate pair at the byte boundary", () => {
    expect(truncateBytes("a😀", 4)).toEqual({ text: "a", truncated: true });
  });

  it("handles empty string", () => {
    expect(truncateBytes("", 10)).toEqual({ text: "", truncated: false });
  });

  it("handles zero cap", () => {
    expect(truncateBytes("anything", 0)).toEqual({ text: "", truncated: true });
  });
});

describe("truncateText", () => {
  it("returns text under the character limit unchanged", () => {
    expect(truncateText("short", 5)).toBe("short");
  });

  it("truncates overlong text and marks the shortened value", () => {
    expect(truncateText("abcdefgh", 5)).toBe("abcd…");
  });

  it("does not split a surrogate pair when truncating", () => {
    expect(truncateText("abc😀def", 5)).toBe("abc…");
  });
});
