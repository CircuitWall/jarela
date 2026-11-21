import { describe, expect, it } from "vitest";
import { isLikelyLocalFileHref, isLocalFilePath } from "./local-file";

describe("isLikelyLocalFileHref", () => {
  it.each([
    "README.md",
    "src/app/page.tsx",
    "../notes/plan.md",
    "C:\\repo\\README.md",
    "~/notes/plan.md",
    "file:///tmp/report.pdf",
    "http://localhost:4312/report.pdf",
  ])("treats %s as a local file", (href) => {
    expect(isLikelyLocalFileHref(href)).toBe(true);
  });

  it.each([
    "https://example.com/docs",
    "#msg-42",
    "/?tab=tools",
    "/api/v1/files/abc.json",
    "mailto:someone@example.com",
    "memory://facts/pricing",
  ])("leaves %s alone", (href) => {
    expect(isLikelyLocalFileHref(href)).toBe(false);
  });
});

describe("isLocalFilePath", () => {
  it.each([
    "src/app/page.tsx",
    "C:\\repo\\README.md",
    "~/notes/plan.md",
    "file:///tmp/report.pdf",
  ])("accepts the path %s", (value) => {
    expect(isLocalFilePath(value)).toBe(true);
  });

  it.each([
    "example.com",
    "v1.2.3",
    "https://example.com",
    "/?tab=tools",
    "/api/v1/files/abc.json",
    "src/",
    "plain words",
    "",
  ])("does not mistake %s for a file", (value) => {
    expect(isLocalFilePath(value)).toBe(false);
  });
});
