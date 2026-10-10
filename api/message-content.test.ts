import { describe, expect, it } from "vitest";
import { stripDeclaredReferencesFence } from "./message-content";

describe("stripDeclaredReferencesFence", () => {
  it("keeps ordinary assistant text unchanged", () => {
    expect(stripDeclaredReferencesFence("A normal response.")).toBe("A normal response.");
  });

  it("hides complete and partial machine-readable reference fences", () => {
    expect(stripDeclaredReferencesFence("Answer.\n```jarela-references\n[]\n```" )).toBe("Answer.");
    expect(stripDeclaredReferencesFence("Answer.\n```jarela-references\n{\"label\":" )).toBe("Answer.");
  });
});