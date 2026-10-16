import { describe, expect, it } from "vitest";
import { applyInstructionEdits } from "./instruction-edits";

function edit(base: string, edits: unknown): string {
  const out = applyInstructionEdits(base, edits);
  if (!out.ok) throw new Error(out.error);
  return out.text;
}

describe("applyInstructionEdits validation", () => {
  it("rejects a non-array and reports the failing index", () => {
    expect(applyInstructionEdits("x", { op: "append" })).toEqual({ ok: false, error: "instructions_edits must be an array" });
    expect(applyInstructionEdits("x", [{ op: "append", text: "a" }, null])).toEqual({ ok: false, error: "instructions_edits[1] must be an object" });
    expect(applyInstructionEdits("x", [{}])).toEqual({ ok: false, error: "instructions_edits[0].op is required" });
    expect(applyInstructionEdits("x", [{ op: "rewrite" }])).toEqual({ ok: false, error: "instructions_edits[0].op is not supported" });
    expect(applyInstructionEdits("x", [{ op: "replace", find: "x" }])).toEqual({ ok: false, error: "instructions_edits[0].replace must be a string" });
  });

  it("fails the whole batch instead of applying a prefix of it", () => {
    const out = applyInstructionEdits("keep", [{ op: "append", text: " more" }, { op: "remove" }]);
    expect(out.ok).toBe(false);
  });
});

describe("append / prepend", () => {
  it("skips an if_missing append when the text is already present, honoring ignore_case", () => {
    const out = applyInstructionEdits("Always cite sources.", [
      { op: "append", text: "always CITE sources.", if_missing: true, ignore_case: true },
      { op: "prepend", text: "Be brief. ", if_missing: true },
    ]);
    expect(out).toEqual({
      ok: true,
      text: "Be brief. Always cite sources.",
      summary: [
        { index: 0, op: "append", applied: false },
        { index: 1, op: "prepend", applied: true },
      ],
    });
  });
});

describe("replace / remove", () => {
  it("treats find text literally, including regex metacharacters and $ patterns", () => {
    expect(edit("cost is $5 (approx.)", [{ op: "replace", find: "$5 (approx.)", replace: "$$ & $&", ignore_case: true }]))
      .toBe("cost is $$ & $&");
    expect(edit("a.b a.b", [{ op: "replace", find: "a.b", replace: "$'", all: true }])).toBe("$' $'");
  });

  it("replaces only the first match unless all is set, and counts replacements", () => {
    const out = applyInstructionEdits("Foo foo FOO", [
      { op: "replace", find: "foo", replace: "bar", ignore_case: true },
      { op: "remove", text: "FOO", all: true },
    ]);
    expect(out).toMatchObject({ ok: true, text: "bar foo ", summary: [{ replacements: 1 }, { removals: 1 }] });
  });

  it("is a no-op for an empty find string rather than inserting between every character", () => {
    expect(edit("abc", [{ op: "replace", find: "", replace: "-", all: true }])).toBe("abc");
  });
});

describe("dedupe_lines", () => {
  it("removes repeated rules case-insensitively but keeps blank lines", () => {
    const out = applyInstructionEdits("- Cite sources\n\n- cite sources \n- Be brief\n\n", [{ op: "dedupe_lines" }]);
    expect(out).toMatchObject({ ok: true, text: "- Cite sources\n\n- Be brief\n\n", summary: [{ removed: 1 }] });
  });

  it("keeps the last occurrence when asked", () => {
    expect(edit("a\nb\nA", [{ op: "dedupe_lines", keep: "last" }])).toBe("b\nA");
  });

  it("never removes code fence markers, fenced content, or horizontal rules", () => {
    const base = [
      "Rule one",
      "```json",
      "{ \"a\": 1 }",
      "```",
      "---",
      "Example two:",
      "```json",
      "{ \"a\": 1 }",
      "```",
      "---",
      "Rule one",
    ].join("\n");
    const expected = base.split("\n").slice(0, -1).join("\n");
    expect(edit(base, [{ op: "dedupe_lines" }])).toBe(expected);
  });

  it("does not treat a fence line with an info string as the closing fence", () => {
    const base = "```text\n```json\nx\nx\n```\n";
    expect(edit(base, [{ op: "dedupe_lines" }])).toBe(base);
  });
  it("preserves CRLF line endings", () => {
    expect(edit("a\r\nb\r\na\r\nc", [{ op: "dedupe_lines" }])).toBe("a\r\nb\r\nc");
  });
});

describe("dedupe_paragraphs", () => {
  it("removes a repeated paragraph and leaves the rest of the text byte-identical", () => {
    const base = "# Rules\n\n  - indented item\n  - second\n\n\nAlways cite.\n\nalways cite.\n";
    expect(edit(base, [{ op: "dedupe_paragraphs" }])).toBe("# Rules\n\n  - indented item\n  - second\n\n\nAlways cite.\n");
  });

  it("does not touch whitespace when there is nothing to remove", () => {
    const base = "\n\nIntro\n\n\n\n    indented code\n";
    const out = applyInstructionEdits(base, [{ op: "dedupe_paragraphs" }]);
    expect(out).toMatchObject({ ok: true, text: base, summary: [{ removed: 0 }] });
  });

  it("respects trim: false by treating differently indented paragraphs as distinct", () => {
    const base = "item\n\n  item";
    expect(edit(base, [{ op: "dedupe_paragraphs", trim: false }])).toBe(base);
    expect(edit(base, [{ op: "dedupe_paragraphs" }])).toBe("item");
  });

  it("keeps the last occurrence and drops the separator that belonged to the removed paragraph", () => {
    expect(edit("A\n\nB\n\na", [{ op: "dedupe_paragraphs", keep: "last" }])).toBe("B\n\na");
  });
});
