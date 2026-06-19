import { describe, it, expect } from "vitest";
import { isMaskedSecret, SECRET_MASKS } from "./secret-mask";

describe("isMaskedSecret", () => {
  it("recognises the credentials API sentinel (***)", () => {
    expect(isMaskedSecret("***")).toBe(true);
  });

  it("recognises the legacy integrations sentinel (********)", () => {
    expect(isMaskedSecret("********")).toBe(true);
  });

  it("treats any non-sentinel string as a real value", () => {
    expect(isMaskedSecret("real-secret")).toBe(false);
    expect(isMaskedSecret("****")).toBe(false);
    expect(isMaskedSecret("**")).toBe(false);
    expect(isMaskedSecret("")).toBe(false);
  });

  it("treats non-string inputs as not masked", () => {
    expect(isMaskedSecret(undefined)).toBe(false);
    expect(isMaskedSecret(null)).toBe(false);
    expect(isMaskedSecret(0)).toBe(false);
    expect(isMaskedSecret({})).toBe(false);
  });

  it("exports both sentinel shapes for callers that need them", () => {
    expect(SECRET_MASKS).toEqual(["***", "********"]);
  });
});
