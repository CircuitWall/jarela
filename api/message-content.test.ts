import { describe, expect, it } from "vitest";
import { parseStoredMessageContent, stripDeclaredReferencesFence } from "./message-content";

describe("parseStoredMessageContent", () => {
  it.each([
    "ordinary text", "", "[incomplete", "[]", "[null]", '["text"]', "[42]",
    "[{}]", '{"type":"text","text":"not an array"}', ' [{"type":"text","text":"leading space"}]',
  ])("keeps non-attachment stored content unchanged: %s", (raw) => {
    expect(parseStoredMessageContent(raw)).toBe(raw);
  });

  it("decodes text and attachment parts without changing their order or payload", () => {
    const parts = [
      { type: "text", text: "Synthetic caption" },
      { type: "image_ref", name: "synthetic.png", media_type: "image/png" },
      { type: "file_ref", name: "synthetic.txt" },
    ];
    expect(parseStoredMessageContent(JSON.stringify(parts))).toEqual(parts);
  });

  it("preserves legacy recognition rather than introducing request validation", () => {
    const parts = [{ type: "future-part", extra: true }, null, "legacy"];
    expect(parseStoredMessageContent(JSON.stringify(parts))).toEqual(parts);
  });
});

describe("stripDeclaredReferencesFence", () => {
  it("keeps ordinary assistant text unchanged", () => {
    expect(stripDeclaredReferencesFence("A normal response.")).toBe("A normal response.");
  });

  it("hides complete and partial machine-readable reference fences", () => {
    expect(stripDeclaredReferencesFence("Answer.\n```jarela-references\n[]\n```" )).toBe("Answer.");
    expect(stripDeclaredReferencesFence("Answer.\n```jarela-references\n{\"label\":" )).toBe("Answer.");
  });
});