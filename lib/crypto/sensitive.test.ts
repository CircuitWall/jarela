import { describe, it, expect } from "vitest";
import { isSensitiveMemoryNamespace, SENSITIVE_MEMORY_NAMESPACES } from "./sensitive";

describe("isSensitiveMemoryNamespace", () => {
  it("returns true for known sensitive namespaces", () => {
    expect(isSensitiveMemoryNamespace("integrations")).toBe(true);
    expect(isSensitiveMemoryNamespace("github-copilot-auth")).toBe(true);
  });

  it("returns false for unknown namespaces", () => {
    expect(isSensitiveMemoryNamespace("agents")).toBe(false);
    expect(isSensitiveMemoryNamespace("")).toBe(false);
    expect(isSensitiveMemoryNamespace("INTEGRATIONS")).toBe(false); // case-sensitive
  });

  it("set membership matches the exported helper", () => {
    for (const ns of SENSITIVE_MEMORY_NAMESPACES) {
      expect(isSensitiveMemoryNamespace(ns)).toBe(true);
    }
  });
});
