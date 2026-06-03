import { describe, it, expect } from "vitest";
import { toolCallSignature, detectToolLoop, looksLikeStall } from "./run-thread";

describe("toolCallSignature", () => {
  it("encodes name and args into a stable string", () => {
    expect(toolCallSignature("file_read", { path: "/a.md" }))
      .toBe('file_read::{"path":"/a.md"}');
  });

  it("is order-insensitive across argument keys", () => {
    expect(toolCallSignature("foo", { a: 1, b: 2 }))
      .toBe(toolCallSignature("foo", { b: 2, a: 1 }));
  });

  it("treats different args as distinct", () => {
    expect(toolCallSignature("file_read", { path: "/a.md" }))
      .not.toBe(toolCallSignature("file_read", { path: "/b.md" }));
  });

  it("treats different tool names as distinct", () => {
    expect(toolCallSignature("file_read", { path: "/x" }))
      .not.toBe(toolCallSignature("file_write", { path: "/x" }));
  });
});

describe("detectToolLoop", () => {
  it("returns null when no signature recurs threshold times", () => {
    const events = [
      { name: "file_read", args: { path: "/a" } },
      { name: "file_read", args: { path: "/b" } },
      { name: "file_write", args: { path: "/a" } },
    ];
    expect(detectToolLoop(events, 3)).toBeNull();
  });

  it("flags the looped tool when the same call recurs threshold times", () => {
    // Mirrors the user-reported failure: 14 file_read calls on the same
    // path interleaved with stall prose, never a file_write.
    const events = Array.from({ length: 14 }, () => ({
      name: "file_read",
      args: { path: "/Users/andwu/Library/CloudStorage/.../doc.md" },
    }));
    expect(detectToolLoop(events, 3)).toBe("file_read");
  });

  it("does not flag distinct args even if the tool name repeats", () => {
    // Legit traversal: walking through 3 different files isn't a loop.
    const events = [
      { name: "file_read", args: { path: "/a" } },
      { name: "file_read", args: { path: "/b" } },
      { name: "file_read", args: { path: "/c" } },
    ];
    expect(detectToolLoop(events, 3)).toBeNull();
  });

  it("returns the FIRST looped tool when multiple loops are present", () => {
    const events = [
      { name: "file_read", args: { path: "/a" } },
      { name: "file_read", args: { path: "/a" } },
      { name: "file_read", args: { path: "/a" } }, // file_read trips first
      { name: "web_fetch", args: { url: "https://x" } },
    ];
    expect(detectToolLoop(events, 3)).toBe("file_read");
  });

  it("ignores empty tool names", () => {
    const events = [
      { name: "", args: { path: "/a" } },
      { name: "", args: { path: "/a" } },
      { name: "", args: { path: "/a" } },
    ];
    expect(detectToolLoop(events, 3)).toBeNull();
  });

  it("returns null for threshold <= 0 (disabled)", () => {
    const events = [
      { name: "file_read", args: { path: "/a" } },
      { name: "file_read", args: { path: "/a" } },
      { name: "file_read", args: { path: "/a" } },
    ];
    expect(detectToolLoop(events, 0)).toBeNull();
    expect(detectToolLoop(events, -1)).toBeNull();
  });

  it("trips at exactly the threshold count", () => {
    const events = [
      { name: "x", args: {} },
      { name: "x", args: {} },
    ];
    expect(detectToolLoop(events, 2)).toBe("x");
    expect(detectToolLoop(events.slice(0, 1), 2)).toBeNull();
  });
});

describe("looksLikeStall", () => {
  it("flags 'one moment' / 'let me check' style endings", () => {
    expect(looksLikeStall("Sure thing. Let me check that for you.")).toBe(true);
    expect(looksLikeStall("Working on it!")).toBe(true);
  });

  it("does not flag normal answers that don't end on a promise", () => {
    expect(looksLikeStall("Here are the results: 42 rows in the table.")).toBe(false);
  });
});
