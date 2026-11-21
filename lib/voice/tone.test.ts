import { describe, expect, it } from "vitest";
import { hasVoiceDirectives, parseVoiceDirectives, stripVoiceDirectives } from "./tone";

describe("voice delivery directives", () => {
  it("extracts the tone and removes the marker from the visible text", () => {
    const parsed = parseVoiceDirectives("[[tone: warm and reassuring]]\n\nHere is the summary.");
    expect(parsed.style).toBe("warm and reassuring");
    expect(parsed.text).toBe("Here is the summary.");
    expect(stripVoiceDirectives("[[tone: warm and reassuring]] Here is the summary.")).toBe("Here is the summary.");
  });

  it("keeps the first directive and drops later ones", () => {
    const parsed = parseVoiceDirectives("[[tone: brisk]]\nOne.\n\n[[tone: other]]\nTwo.");
    expect(parsed.style).toBe("brisk");
    expect(parsed.text).toBe("One.\n\nTwo.");
    expect(parsed.text).not.toContain("[[");
  });

  it("preserves indentation and whitespace when there is no directive", () => {
    const fence = "```mermaid\nflowchart TD\n   A[Start] --> B[Finish]\n```";
    expect(stripVoiceDirectives(fence)).toBe(fence);
    expect(parseVoiceDirectives(fence).text).toBe(fence);
  });

  it("strips momentary vocal tags from speech and display", () => {
    const raw = "Wait <short pause> did you hear that? <sigh>";
    expect(parseVoiceDirectives(raw).text).toBe("Wait did you hear that?");
    expect(parseVoiceDirectives(raw, { keepVocalTags: true }).text).toBe(raw);
  });

  it("leaves ordinary markup, citations and code alone", () => {
    const raw = "See [1](https://example.test) and `<div>` and [[not a tone]] here.";
    expect(parseVoiceDirectives(raw)).toEqual({ text: raw, style: null });
  });

  it("reports absence cleanly", () => {
    expect(hasVoiceDirectives("plain reply")).toBe(false);
    expect(hasVoiceDirectives("[[tone: warm]] reply")).toBe(true);
    expect(hasVoiceDirectives("a <sigh> here")).toBe(true);
    expect(() => parseVoiceDirectives("plain reply")).not.toThrow();
    // Repeated calls must not depend on regex state.
    expect(hasVoiceDirectives("a <sigh> here")).toBe(true);
  });
});
