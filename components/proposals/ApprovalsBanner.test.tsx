import { describe, expect, it } from "vitest";
import { formatPayloadPreview } from "./ApprovalsBanner";

describe("formatPayloadPreview", () => {
  it("bounds very large proposal payloads instead of rendering the full JSON", () => {
    const payload = {
      tools: Array.from({ length: 1_000 }, (_, i) => ({
        name: `tool-${i}`,
        description: "x".repeat(200),
      })),
    };

    const result = formatPayloadPreview(payload, {
      maxChars: 500,
      maxEntries: 1_000,
      maxStringChars: 100,
    });

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(550);
    expect(result.text).toContain("preview truncated");
    expect(result.text).toContain("tool-0");
    expect(result.text).not.toContain("tool-999");
  });
});
