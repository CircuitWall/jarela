import { describe, expect, it } from "vitest";
import { isBasicToolCategory, normalizeToolCategory } from "./categories";

describe("tool category normalization", () => {
  it("defaults missing or blank external categories to Other, not MCP", () => {
    expect(normalizeToolCategory(undefined)).toBe("Other");
    expect(normalizeToolCategory(null)).toBe("Other");
    expect(normalizeToolCategory("   ")).toBe("Other");
    expect(normalizeToolCategory("MCP")).toBe("MCP");
  });

  it("trims categories and recognizes only basic categories as basic", () => {
    expect(normalizeToolCategory("  Files ")).toBe("Files");
    expect(isBasicToolCategory("Files")).toBe(true);
    expect(isBasicToolCategory("Other")).toBe(false);
  });
});
