import { describe, expect, it } from "vitest";
import { diffPrompts, diffTools, splitSystemPromptSections } from "./surface-snapshot";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});

describe("splitSystemPromptSections", () => {
  it("splits on section headers and drops host- and time-dependent content", () => {
    const sections = splitSystemPromptSections([
      "intro line",
      "--- Tool usage SOP ---",
      "1. Use tools.",
      "<!-- jarela:dynamic -->",
      "--- Host environment ---",
      "OS: win32",
      "--- System signals ---",
      "[]",
      "--- Enabled tools ---",
      "Current time: 2026-01-01T00:00:00Z (UTC).",
      "Current local date and time: 2026-01-01 01:00",
      "- web_search",
    ].join("\n"));
    expect(sections).toEqual({
      Preamble: "intro line",
      "Tool usage SOP": "1. Use tools.",
      "Enabled tools": "- web_search",
    });
  });
});

describe("diffPrompts", () => {
  it("reports line-level additions and removals and ignores whitespace-only edits", () => {
    const prev = {
      a: { source: "a.ts", text: "keep\nold rule" },
      b: { source: "b.ts", text: "same" },
      gone: { source: "g.ts", text: "bye" },
    };
    const next = {
      a: { source: "a.ts", text: "keep\nnew rule" },
      b: { source: "b.ts", text: "  same  \n" },
      fresh: { source: "f.ts", text: "hello" },
    };
    expect(diffPrompts(prev, next)).toEqual([
      { id: "a", source: "a.ts", change: "changed", added_lines: ["new rule"], removed_lines: ["old rule"], omitted_lines: 0 },
      { id: "fresh", source: "f.ts", change: "added", added_lines: [], removed_lines: [], omitted_lines: 0 },
      { id: "gone", source: "g.ts", change: "removed", added_lines: [], removed_lines: [], omitted_lines: 0 },
    ]);
  });

  it("caps excerpts and counts the omitted lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const [change] = diffPrompts({ p: { source: "p.ts", text: "x" } }, { p: { source: "p.ts", text: lines } });
    expect(change.added_lines).toHaveLength(12);
    expect(change.omitted_lines).toBe(8);
  });
});

describe("diffTools", () => {
  it("classifies parameter, requirement, and description changes", () => {
    const prev = {
      t: { description: "Old.", parameters: objectSchema({ a: { type: "string" }, b: { type: "number" }, gone: {} }, ["a"]) },
      same: { description: "Same.", parameters: objectSchema({ q: { type: "string" } }) },
    };
    const next = {
      t: { description: "New.", parameters: objectSchema({ a: { type: "string" }, b: { type: "string" }, c: {} }, ["a", "c"]) },
      same: { description: "Same.", parameters: objectSchema({ q: { type: "string" } }) },
    };
    expect(diffTools(prev, next)).toEqual([{
      name: "t",
      change: "changed",
      description_changed: true,
      description: "New.",
      previous_description: "Old.",
      params_added: ["c"],
      params_removed: ["gone"],
      params_changed: ["b"],
      required_added: ["c"],
      required_removed: [],
    }]);
  });

  it("treats property order differences as unchanged", () => {
    const prev = { t: { description: "d", parameters: objectSchema({ a: { type: "string", description: "x" } }) } };
    const next = { t: { description: "d", parameters: objectSchema({ a: { description: "x", type: "string" } }) } };
    expect(diffTools(prev, next)).toEqual([]);
  });

  it("records added and removed tools", () => {
    const tool = { description: "T.", parameters: objectSchema({ a: {} }, ["a"]) };
    expect(diffTools({ old: tool }, { added: tool })).toEqual([
      {
        name: "added", change: "added", description_changed: false, description: "T.",
        params_added: ["a"], params_removed: [], params_changed: [], required_added: ["a"], required_removed: [],
      },
      {
        name: "old", change: "removed", description_changed: false,
        params_added: [], params_removed: [], params_changed: [], required_added: [], required_removed: [],
      },
    ]);
  });
});
