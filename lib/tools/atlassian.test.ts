import { describe, it, expect } from "vitest";
import { resolveCustomFieldNames, extractFieldValue, type JiraFieldDef } from "./atlassian";

const fields: JiraFieldDef[] = [
  { id: "summary", name: "Summary", custom: false },
  { id: "customfield_10473", name: "Vulnerability Description", custom: true },
  { id: "customfield_10500", name: "Affected Component", custom: true },
  { id: "customfield_10600", name: "Story Points", custom: true },
];

describe("resolveCustomFieldNames", () => {
  it("matches by exact customfield id", () => {
    const r = resolveCustomFieldNames(["customfield_10473"], fields);
    expect(r.resolved).toEqual([
      { input: "customfield_10473", id: "customfield_10473", name: "Vulnerability Description" },
    ]);
    expect(r.unresolved).toEqual([]);
  });

  it("matches display names case-insensitively with surrounding whitespace", () => {
    const r = resolveCustomFieldNames(["  vulnerability description  "], fields);
    expect(r.resolved).toEqual([
      { input: "  vulnerability description  ", id: "customfield_10473", name: "Vulnerability Description" },
    ]);
  });

  it("partitions resolved and unresolved inputs", () => {
    const r = resolveCustomFieldNames(
      ["Story Points", "Bogus Field", "customfield_10500"],
      fields,
    );
    expect(r.resolved.map((x) => x.id)).toEqual(["customfield_10600", "customfield_10500"]);
    expect(r.unresolved).toEqual(["Bogus Field"]);
  });

  it("returns empty results for empty input", () => {
    expect(resolveCustomFieldNames([], fields)).toEqual({ resolved: [], unresolved: [] });
  });
});

describe("extractFieldValue", () => {
  it("prefers rendered HTML, stripped to plain text", () => {
    const adf = { type: "doc", version: 1, content: [] };
    const html = "<p>SQL injection in <strong>/api/login</strong></p><p>CVE-2024-9999</p>";
    expect(extractFieldValue(adf, html)).toBe("SQL injection in /api/login\n\nCVE-2024-9999");
  });

  it("falls back to simplifyADF when no rendered HTML", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }],
    };
    expect(extractFieldValue(adf, undefined)).toBe("hello world");
  });

  it("passes through scalar values", () => {
    expect(extractFieldValue("plain text", undefined)).toBe("plain text");
    expect(extractFieldValue(8, undefined)).toBe(8);
    expect(extractFieldValue(true, undefined)).toBe(true);
    expect(extractFieldValue(null, undefined)).toBe(null);
  });

  it("flattens single-select option { value }", () => {
    expect(extractFieldValue({ value: "High", id: "10001" }, undefined)).toBe("High");
  });

  it("flattens user picker { displayName }", () => {
    expect(extractFieldValue({ accountId: "abc", displayName: "Andrew Wu" }, undefined)).toBe("Andrew Wu");
  });

  it("flattens status/priority { name }", () => {
    expect(extractFieldValue({ name: "In Progress" }, undefined)).toBe("In Progress");
  });

  it("flattens arrays of options to their string values", () => {
    expect(
      extractFieldValue(
        [{ value: "alpha" }, { value: "beta" }, { name: "gamma" }],
        undefined,
      ),
    ).toEqual(["alpha", "beta", "gamma"]);
  });

  it("converts <li> to bullets and <br> to newlines", () => {
    const html = "<ul><li>one</li><li>two</li></ul>";
    expect(extractFieldValue(null, html)).toBe("• one\n• two");
  });

  it("decodes common HTML entities", () => {
    expect(extractFieldValue(null, "&lt;script&gt; &amp; more")).toBe("<script> & more");
  });
});
