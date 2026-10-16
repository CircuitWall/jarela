import { describe, expect, it } from "vitest";
import {
  buildMultipleMatchesDiagnostic,
  buildNotFoundDiagnostic,
  conformEol,
  dominantEol,
  lineNumberAt,
  locateOldString,
} from "./edit-match";

const slice = (raw: string, r: { start: number; end: number }) => raw.slice(r.start, r.end);

describe("locateOldString", () => {
  it("returns every non-overlapping exact occurrence", () => {
    const attempt = locateOldString("aaaa", "aa", "exact");
    expect(attempt.ranges).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    expect(attempt).toMatchObject({ usedStrategy: "exact", crlfAdjusted: false });
  });

  it("never matches an empty old_string", () => {
    expect(locateOldString("abc", "", "fuzzy").ranges).toEqual([]);
  });

  it("maps an LF old_string onto a CRLF file in raw coordinates", () => {
    const raw = "one\r\ntwo\r\nthree\r\n";
    const attempt = locateOldString(raw, "two\nthree\n", "exact");
    expect(attempt.crlfAdjusted).toBe(true);
    expect(slice(raw, attempt.ranges[0])).toBe("two\r\nthree\r\n");
  });

  it("maps a CRLF old_string onto an LF file", () => {
    const raw = "a\nb\nc";
    expect(slice(raw, locateOldString(raw, "b\r\nc", "exact").ranges[0])).toBe("b\nc");
  });

  it("does not apply whitespace strategies unless requested", () => {
    const raw = "if (x)   {\n  y();\n}";
    expect(locateOldString(raw, "if (x) {", "exact").ranges).toEqual([]);
    const attempt = locateOldString(raw, "if (x) {", "normalize_whitespace");
    expect(attempt.usedStrategy).toBe("normalize_whitespace");
    expect(slice(raw, attempt.ranges[0])).toBe("if (x)   {");
  });

  it("matches trailing-whitespace drift and keeps the original text in range", () => {
    const raw = "alpha  \t\nbeta\n";
    const attempt = locateOldString(raw, "alpha\nbeta", "trim_trailing");
    expect(attempt.usedStrategy).toBe("trim_trailing");
    expect(slice(raw, attempt.ranges[0])).toBe("alpha  \t\nbeta");
  });

  it("keeps the leading indentation of the file when normalizing whitespace", () => {
    const raw = "class A {\n    method() {\n        return 1;\n    }\n}";
    const attempt = locateOldString(raw, "method() {\n return 1;", "normalize_whitespace");
    expect(slice(raw, attempt.ranges[0])).toBe("method() {\n        return 1;");
  });

  it("returns a fuzzy range covering whole lines in an LF file", () => {
    const raw = "header\nconst total = items.reduce((a, b) => a + b, 0);\nfooter\n";
    const attempt = locateOldString(raw, "const totl = items.reduce((a, b) => a + b, 0);", "fuzzy");
    expect(attempt.usedStrategy).toBe("fuzzy");
    expect(slice(raw, attempt.ranges[0])).toBe("const total = items.reduce((a, b) => a + b, 0);");
  });

  it("returns a fuzzy range in raw coordinates for a CRLF file", () => {
    const raw = "line one\r\nline two\r\nconst total = items.reduce((a, b) => a + b, 0);\r\nreturn total;\r\n";
    const attempt = locateOldString(raw, "const totl = items.reduce((a, b) => a + b, 0);\nreturn total;", "fuzzy");
    expect(attempt.usedStrategy).toBe("fuzzy");
    expect(slice(raw, attempt.ranges[0])).toBe("const total = items.reduce((a, b) => a + b, 0);\r\nreturn total;");
  });

  it("returns a fuzzy range in raw coordinates for a classic-Mac CR file", () => {
    const raw = "first\rsecond\rconst total = items.reduce((a, b) => a + b, 0);\rend";
    const attempt = locateOldString(raw, "const totl = items.reduce((a, b) => a + b, 0);", "fuzzy");
    expect(slice(raw, attempt.ranges[0])).toBe("const total = items.reduce((a, b) => a + b, 0);");
  });

  it("refuses an ambiguous fuzzy match", () => {
    const line = "const total = items.reduce((a, b) => a + b, 0);";
    const raw = `${line}\nmiddle\n${line}\n`;
    expect(locateOldString(raw, line.replace("total", "totl"), "fuzzy").ranges).toEqual([]);
  });

  it("refuses fuzzy matching for short old_strings", () => {
    expect(locateOldString("const x = 1;\n", "const x = 2", "fuzzy").ranges).toEqual([]);
  });

  it("handles non-BMP characters without splitting surrogate pairs", () => {
    const raw = "emoji 😀 here\r\nnext";
    const attempt = locateOldString(raw, "😀 here\nnext", "exact");
    expect(slice(raw, attempt.ranges[0])).toBe("😀 here\r\nnext");
  });
});

describe("EOL helpers", () => {
  it("picks the majority line ending and null for single-line text", () => {
    expect(dominantEol("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(dominantEol("a\nb\r\nc\n")).toBe("\n");
    expect(dominantEol("single line")).toBeNull();
  });

  it("conforms mixed endings without doubling carriage returns", () => {
    expect(conformEol("a\r\nb\nc", "\r\n")).toBe("a\r\nb\r\nc");
    expect(conformEol("a\r\nb\nc", "\n")).toBe("a\nb\nc");
  });

  it("counts lines up to an offset and clamps past the end", () => {
    expect(lineNumberAt("a\nb\nc", 0)).toBe(1);
    expect(lineNumberAt("a\nb\nc", 4)).toBe(3);
    expect(lineNumberAt("a\nb", 99)).toBe(2);
  });
});

describe("diagnostics", () => {
  it("points at the nearest line and suggests a strategy that would match", () => {
    const raw = "function run() {\n  doWork(  1 );\n}\n";
    const diag = buildNotFoundDiagnostic(raw, "doWork( 1 );");
    expect(diag.nearest_match?.line).toBe(2);
    expect(diag.nearest_match?.snippet).toContain("2:   doWork(  1 );");
    expect(diag.normalized_hint).toBe('matches uniquely at line 2 if strategy="normalize_whitespace" is used');
  });

  it("returns no nearest match for whitespace-only old_strings", () => {
    const diag = buildNotFoundDiagnostic("abc\n", "   \n  ");
    expect(diag.nearest_match).toBeNull();
    expect(diag.normalized_hint).toBeNull();
  });

  it("reports every occurrence line for multiple matches", () => {
    const raw = "x\nfoo\ny\nfoo\n";
    const { ranges } = locateOldString(raw, "foo", "exact");
    expect(buildMultipleMatchesDiagnostic(raw, ranges)).toEqual({ reason: "multiple_matches", occurrences: [2, 4] });
  });
});
