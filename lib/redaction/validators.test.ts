import { describe, it, expect } from "vitest";
import { luhn, mod97, personnummer_check } from "./validators";

describe("luhn", () => {
  it("accepts valid Luhn digits", () => {
    // Classic test cases.
    expect(luhn("4532015112830366")).toBe(true);
    expect(luhn("79927398713")).toBe(true);
  });
  it("rejects invalid Luhn digits", () => {
    expect(luhn("4532015112830367")).toBe(false);
    expect(luhn("12345678")).toBe(false);
  });
  it("strips non-digits before checking", () => {
    expect(luhn("4532-0151-1283-0366")).toBe(true);
  });
  it("rejects trivially short input", () => {
    expect(luhn("")).toBe(false);
    expect(luhn("4")).toBe(false);
  });
});

describe("personnummer_check", () => {
  it("accepts a known-good 10-digit personnummer", () => {
    // 811218-9876 is a commonly cited test vector with valid Luhn.
    expect(personnummer_check("811218-9876")).toBe(true);
  });
  it("accepts the equivalent 12-digit form", () => {
    expect(personnummer_check("19811218-9876")).toBe(true);
  });
  it("rejects when the check digit is wrong", () => {
    expect(personnummer_check("811218-9870")).toBe(false);
  });
  it("rejects nonsense dates", () => {
    // Month 13 — Luhn might pass, date sanity must fail.
    expect(personnummer_check("811318-9876")).toBe(false);
  });
  it("rejects pure dates that happen to have 6+4 digits", () => {
    expect(personnummer_check("2026-0612")).toBe(false);
  });
});

describe("mod97 (IBAN)", () => {
  it("accepts a known-good IBAN (GB)", () => {
    expect(mod97("GB82WEST12345698765432")).toBe(true);
  });
  it("accepts a known-good IBAN (DE)", () => {
    expect(mod97("DE89370400440532013000")).toBe(true);
  });
  it("ignores spaces", () => {
    expect(mod97("GB82 WEST 1234 5698 7654 32")).toBe(true);
  });
  it("rejects invalid checksums", () => {
    expect(mod97("GB82WEST12345698765431")).toBe(false);
  });
  it("rejects non-iban garbage", () => {
    expect(mod97("not an iban")).toBe(false);
  });
});
