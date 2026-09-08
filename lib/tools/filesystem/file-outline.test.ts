import { describe, it, expect } from "vitest";
import { buildOutline, shouldOutline, looksLikeText, capOutline } from "./file-outline";

describe("file-outline · shouldOutline / looksLikeText", () => {
  it("treats UTF-8 text as text", () => {
    expect(looksLikeText("hello\nworld")).toBe(true);
  });
  it("rejects content with NUL bytes (binary heuristic)", () => {
    expect(looksLikeText("hello\u0000world")).toBe(false);
  });
  it("outlines recognised extensions", () => {
    expect(shouldOutline("/x/foo.md", "# title")).toBe(true);
    expect(shouldOutline("/x/foo.ts", "export function a(){}")).toBe(true);
    expect(shouldOutline("/x/foo.png", "")).toBe(false);
  });
});

describe("file-outline · markdown", () => {
  it("captures ATX headings with depth", () => {
    const md = ["# A", "## B", "### C", "text", "## D"].join("\n");
    const out = buildOutline("/x/r.md", md);
    expect(out).toEqual([
      { kind: "heading", name: "A", line: 1, depth: 1 },
      { kind: "heading", name: "B", line: 2, depth: 2 },
      { kind: "heading", name: "C", line: 3, depth: 3 },
      { kind: "heading", name: "D", line: 5, depth: 2 },
    ]);
  });
  it("ignores ATX-looking lines inside fenced code blocks", () => {
    const md = ["# real", "```", "# fake", "```", "## also real"].join("\n");
    const out = buildOutline("/x/r.md", md);
    expect(out.map((e) => e.name)).toEqual(["real", "also real"]);
  });
  it("captures setext h1/h2", () => {
    const md = ["Title", "=====", "", "Sub", "---"].join("\n");
    const out = buildOutline("/x/r.md", md);
    expect(out).toEqual([
      { kind: "heading", name: "Title", line: 1, depth: 1 },
      { kind: "heading", name: "Sub", line: 4, depth: 2 },
    ]);
  });
});

describe("file-outline · TypeScript", () => {
  it("captures top-level function / class / interface / type / const", () => {
    const ts = [
      "import x from 'y';",
      "export function foo() { return 1 }",
      "async function bar() {}",
      "export class Baz {}",
      "interface IFoo {}",
      "export type T = number;",
      "export const C = 1;",
      "  const nested = 2;", // indented — should be skipped
    ].join("\n");
    const out = buildOutline("/x/r.ts", ts);
    expect(out).toEqual([
      { kind: "function", name: "foo", line: 2 },
      { kind: "function", name: "bar", line: 3 },
      { kind: "class", name: "Baz", line: 4 },
      { kind: "interface", name: "IFoo", line: 5 },
      { kind: "type", name: "T", line: 6 },
      { kind: "const", name: "C", line: 7 },
    ]);
  });
});

describe("file-outline · Python", () => {
  it("captures def/class with indent depth", () => {
    const py = [
      "def a():",
      "    def inner():",
      "        pass",
      "class B:",
      "    def m(self):",
      "        pass",
    ].join("\n");
    const out = buildOutline("/x/r.py", py);
    expect(out).toEqual([
      { kind: "function", name: "a", line: 1, depth: 0 },
      { kind: "function", name: "inner", line: 2, depth: 1 },
      { kind: "class", name: "B", line: 4, depth: 0 },
      { kind: "function", name: "m", line: 5, depth: 1 },
    ]);
  });
});

describe("file-outline · JSON", () => {
  it("captures depth-1 keys only", () => {
    const json = [
      "{",
      '  "name": "x",',
      '  "version": "1.0.0",',
      '  "dependencies": {',
      '    "lodash": "1.0"',
      "  },",
      '  "scripts": { "build": "tsc" }',
      "}",
    ].join("\n");
    const out = buildOutline("/x/r.json", json);
    expect(out.map((e) => e.name)).toEqual(["name", "version", "dependencies", "scripts"]);
  });
});

describe("file-outline · YAML", () => {
  it("captures top-level and 2-space-indent keys", () => {
    const yml = [
      "name: ci",
      "on:",
      "  push:",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
    ].join("\n");
    const out = buildOutline("/x/r.yml", yml);
    expect(out).toEqual([
      { kind: "key", name: "name", line: 1, depth: 0 },
      { kind: "key", name: "on", line: 2, depth: 0 },
      { kind: "key", name: "push", line: 3, depth: 1 },
      { kind: "key", name: "jobs", line: 4, depth: 0 },
      { kind: "key", name: "build", line: 5, depth: 1 },
    ]);
  });
});

describe("file-outline · generic fallback", () => {
  it("finds markdown headings in unknown extensions", () => {
    const out = buildOutline("/x/NOTES", "# Title\nbody\n## Sub");
    expect(out.map((e) => e.name)).toEqual(["Title", "Sub"]);
  });
});

describe("file-outline · capOutline", () => {
  it("caps at 200 entries and marks truncated", () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({ kind: "x", name: `n${i}`, line: i + 1 }));
    const r = capOutline(entries);
    expect(r.entries.length).toBe(200);
    expect(r.truncated).toBe(true);
  });
  it("passes through small lists", () => {
    const r = capOutline([{ kind: "x", name: "n", line: 1 }]);
    expect(r.truncated).toBe(false);
    expect(r.entries.length).toBe(1);
  });
});
