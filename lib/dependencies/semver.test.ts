import { describe, expect, it } from "vitest";
import { compareVersions, parseRange, parseVersion, satisfiesRange } from "./semver";

describe("parseVersion", () => {
  it("parses full versions and pads partials", () => {
    expect(parseVersion("24.15.3")).toEqual({ major: 24, minor: 15, patch: 3 });
    expect(parseVersion("v24.15")).toEqual({ major: 24, minor: 15, patch: 0 });
    expect(parseVersion("24")).toEqual({ major: 24, minor: 0, patch: 0 });
  });

  it("ignores prerelease and build suffixes", () => {
    expect(parseVersion("24.15.0-nightly.20260101")).toEqual({ major: 24, minor: 15, patch: 0 });
  });

  it("rejects non-numeric input", () => {
    expect(parseVersion("next")).toBeNull();
    expect(parseVersion("24.x")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by major, minor, then patch", () => {
    const a = { major: 24, minor: 15, patch: 0 };
    const b = { major: 24, minor: 15, patch: 1 };
    expect(compareVersions(a, b)).toBeLessThan(0);
    expect(compareVersions(b, a)).toBeGreaterThan(0);
    expect(compareVersions(a, a)).toBe(0);
  });
});

describe("satisfiesRange", () => {
  const engine = "^24.15.0 || >=26.0.0";

  it("accepts the app engine range", () => {
    expect(satisfiesRange("24.15.0", engine)).toBe(true);
    expect(satisfiesRange("24.15.9", engine)).toBe(true);
    expect(satisfiesRange("26.0.0", engine)).toBe(true);
    expect(satisfiesRange("27.4.1", engine)).toBe(true);
  });

  it("rejects versions outside the app engine range", () => {
    expect(satisfiesRange("24.14.9", engine)).toBe(false);
    expect(satisfiesRange("25.9.9", engine)).toBe(false);
    expect(satisfiesRange("22.22.2", engine)).toBe(false);
  });

  it("applies caret semantics for zero majors", () => {
    expect(satisfiesRange("0.2.5", "^0.2.3")).toBe(true);
    expect(satisfiesRange("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfiesRange("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfiesRange("0.0.4", "^0.0.3")).toBe(false);
  });

  it("applies tilde semantics", () => {
    expect(satisfiesRange("22.12.0", "~22.12.0")).toBe(true);
    expect(satisfiesRange("22.12.9", "~22.12.0")).toBe(true);
    expect(satisfiesRange("22.13.0", "~22.12.0")).toBe(false);
    expect(satisfiesRange("22.11.9", "~22.12.0")).toBe(false);
  });

  it("treats partial versions as the same band npm uses", () => {
    expect(satisfiesRange("24.9.0", "24")).toBe(true);
    expect(satisfiesRange("25.0.0", "24")).toBe(false);
    expect(satisfiesRange("24.15.3", "24.15")).toBe(true);
    expect(satisfiesRange("24.16.0", "24.15")).toBe(false);
    expect(satisfiesRange("24.15.0", "24.x")).toBe(true);
    expect(satisfiesRange("25.0.0", "24.x")).toBe(false);
  });

  it("supports wildcards and inequality comparators", () => {
    expect(satisfiesRange("24.15.0", "*")).toBe(true);
    expect(satisfiesRange("24.15.9", ">24.15")).toBe(false);
    expect(satisfiesRange("24.16.0", ">24.15")).toBe(true);
    expect(satisfiesRange("24.15.9", "<=24.15")).toBe(true);
    expect(satisfiesRange("24.16.0", "<=24.15")).toBe(false);
    expect(satisfiesRange("24.15.0", ">=24.15.0 <25.0.0")).toBe(true);
    expect(satisfiesRange("25.0.0", ">=24.15.0 <25.0.0")).toBe(false);
  });

  it("returns false for unusable ranges instead of guessing", () => {
    expect(parseRange("not-a-range")).toBeNull();
    expect(parseRange("^")).toBeNull();
    expect(satisfiesRange("24.15.0", "not-a-range")).toBe(false);
  });
});
