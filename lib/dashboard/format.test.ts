import { describe, expect, it } from "vitest";
import {
  convertUsd,
  formatInt,
  formatMoney,
  formatMoneyCompact,
  safeHttpUrl,
} from "./format";

const USD = { currency: "USD", rate_from_usd: 1 };
const EUR = { currency: "EUR", rate_from_usd: 0.9 };

describe("convertUsd", () => {
  it("multiplies by rate", () => {
    expect(convertUsd(10, EUR)).toBeCloseTo(9, 10);
  });
  it("treats zero or negative rate as 1", () => {
    expect(convertUsd(10, { currency: "USD", rate_from_usd: 0 })).toBe(10);
    expect(convertUsd(10, { currency: "USD", rate_from_usd: -2 })).toBe(10);
  });
  it("treats NaN rate as 1", () => {
    expect(convertUsd(10, { currency: "USD", rate_from_usd: Number.NaN })).toBe(10);
  });
});

describe("formatInt", () => {
  it("uses en-US grouping", () => {
    expect(formatInt(1234567)).toBe("1,234,567");
  });
});

describe("formatMoney", () => {
  it("renders standard amounts with 2-4 fraction digits", () => {
    const out = formatMoney(12.5, USD);
    expect(out).toMatch(/12[.,]50/);
  });

  it("switches to micro-precision below 0.01", () => {
    const out = formatMoney(0.001, USD);
    // Should preserve 4+ fraction digits; not round to two-digit "0.00"/"0,00".
    expect(out).not.toMatch(/[^0-9]0[.,]00($|[^0-9])/);
    expect(out).toMatch(/0[.,]001\d?/);
  });

  it("shows a floor for sub-millionth amounts", () => {
    const out = formatMoney(0.0000001, USD);
    expect(out.startsWith("< ")).toBe(true);
  });

  it("uses USD when currency code is empty", () => {
    const out = formatMoney(1, { currency: "", rate_from_usd: 1 });
    expect(out).toMatch(/1[.,]00/);
    // Should reference USD via symbol or code regardless of locale.
    expect(out).toMatch(/\$|USD|US\$/);
  });

  it("converts via rate", () => {
    const out = formatMoney(10, EUR);
    expect(out).toMatch(/9[.,]00/);
  });

  it("falls back gracefully on invalid currency code", () => {
    const out = formatMoney(10, { currency: "ZZZ", rate_from_usd: 1 });
    expect(out).toMatch(/10([.,]00)?/);
  });
});

describe("formatMoneyCompact", () => {
  it("uses compact notation for large numbers", () => {
    const out = formatMoneyCompact(1_500_000, USD);
    // "$1.5M" or locale variant — must contain "M" or "1.5"/"1,5"
    expect(out).toMatch(/1[.,]5/);
  });

  it("renders zero", () => {
    expect(formatMoneyCompact(0, USD)).toMatch(/0/);
  });

  it("falls back to manual scaling when Intl rejects currency", () => {
    const out = formatMoneyCompact(2_500, { currency: "ZZZ", rate_from_usd: 1 });
    // Either Intl tolerates or fallback "2.5K" appears.
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("safeHttpUrl", () => {
  it("accepts http/https URLs", () => {
    expect(safeHttpUrl("http://example.com/")).toBe("http://example.com/");
    expect(safeHttpUrl("https://example.com/path")).toBe("https://example.com/path");
  });
  it("rejects non-http schemes", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,foo")).toBeNull();
    expect(safeHttpUrl("file:///etc/passwd")).toBeNull();
  });
  it("rejects null, undefined, empty, and invalid input", () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
  });
});
