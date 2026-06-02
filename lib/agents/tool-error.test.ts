import { describe, it, expect } from "vitest";
import { extractToolError } from "./tool-error";

describe("extractToolError", () => {
  it("returns null on success-shaped object", () => {
    expect(extractToolError({ ok: true })).toBeNull();
    expect(extractToolError({ data: "hello" })).toBeNull();
    expect(extractToolError({ kind: "json", data: { x: 1 } })).toBeNull();
  });

  it("returns null on non-object inputs", () => {
    expect(extractToolError(null)).toBeNull();
    expect(extractToolError(undefined)).toBeNull();
    expect(extractToolError("plain string")).toBeNull();
    expect(extractToolError(42)).toBeNull();
    expect(extractToolError([])).toBeNull();
  });

  it("reads PR-4 ToolResult union {kind:'error'}", () => {
    expect(extractToolError({ kind: "error", code: "tool_timeout", message: "exceeded 60s" }))
      .toEqual({ code: "tool_timeout", message: "exceeded 60s" });
  });

  it("falls back to default message when message field is missing", () => {
    expect(extractToolError({ kind: "error", code: "x" }))
      .toEqual({ code: "x", message: "Tool returned an error." });
  });

  it("falls back to default code when code field is missing on kind:error", () => {
    expect(extractToolError({ kind: "error", message: "boom" }))
      .toEqual({ code: "tool_error", message: "boom" });
  });

  it("reads legacy {error: '...', code} envelope", () => {
    expect(extractToolError({ error: "Atlassian 401: token invalid", code: "http_401" }))
      .toEqual({ code: "http_401", message: "Atlassian 401: token invalid" });
  });

  it("reads legacy {error: '...'} without code (defaults code to tool_error)", () => {
    expect(extractToolError({ error: "boom" }))
      .toEqual({ code: "tool_error", message: "boom" });
  });

  it("stringifies non-string error field", () => {
    const result = extractToolError({ error: { reason: "deep" }, code: "x" });
    expect(result?.code).toBe("x");
    expect(result?.message).toContain("reason");
  });

  it("treats empty-string code as missing (uses default)", () => {
    expect(extractToolError({ kind: "error", code: "", message: "m" }))
      .toEqual({ code: "tool_error", message: "m" });
  });
});
