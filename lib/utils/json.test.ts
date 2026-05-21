import { describe, it, expect } from "vitest";
import { parseJsonSafe } from "./json";

describe("parseJsonSafe", () => {
  it("parses valid JSON", () => {
    expect(parseJsonSafe<{ a: number }>('{"a":1}', { a: 0 })).toEqual({ a: 1 });
  });

  it("returns the fallback on malformed JSON", () => {
    expect(parseJsonSafe<{ a: number }>("not json", { a: 0 })).toEqual({ a: 0 });
  });

  it("returns the fallback on empty input", () => {
    expect(parseJsonSafe<string[]>("", [])).toEqual([]);
  });

  it("returns undefined when no fallback and input is malformed", () => {
    expect(parseJsonSafe<unknown>("garbage")).toBeUndefined();
  });

  it("parses primitive JSON values (numbers, booleans, null)", () => {
    expect(parseJsonSafe<number>("42", 0)).toBe(42);
    expect(parseJsonSafe<boolean>("true", false)).toBe(true);
    expect(parseJsonSafe<null>("null", undefined as unknown as null)).toBeNull();
  });

  it("parses arrays", () => {
    expect(parseJsonSafe<number[]>("[1,2,3]", [])).toEqual([1, 2, 3]);
  });
});
