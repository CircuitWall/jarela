import { describe, it, expect } from "vitest";
import { buildCssSelector, composePayload } from "./helpers.mjs";

// ---------------------------------------------------------------------------
// buildCssSelector — duck-typed against a minimal Element-shaped object so we
// don't need jsdom for a 30-line helper.
// ---------------------------------------------------------------------------

function el(spec) {
  // spec = { tag, id?, classes?, parent?, prevSiblings?: tagList, nextSiblings?: tagList }
  // prev/next siblings are arrays of tag names (uppercased) used to compute
  // :nth-of-type indices.
  const e = {
    tagName: spec.tag.toUpperCase(),
    id: spec.id ?? "",
    classList: spec.classes ? Object.freeze([...spec.classes]) : Object.freeze([]),
    parentElement: spec.parent ?? null,
    _prev: (spec.prevSiblings ?? []).map((t) => t.toUpperCase()),
    _next: (spec.nextSiblings ?? []).map((t) => t.toUpperCase()),
  };
  return e;
}

describe("buildCssSelector", () => {
  it("returns the id selector when an id is present", () => {
    const e = el({ tag: "div", id: "sidebar" });
    expect(buildCssSelector(e)).toBe("#sidebar");
  });

  it("returns tag for top-level body or html", () => {
    const e = el({ tag: "body" });
    expect(buildCssSelector(e)).toBe("body");
  });

  it("walks up the parent chain when no id is present", () => {
    const main = el({ tag: "main" });
    const article = el({ tag: "article", parent: main });
    const p = el({ tag: "p", parent: article });
    expect(buildCssSelector(p)).toBe("main > article > p");
  });

  it("uses :nth-of-type when there are same-tag siblings before", () => {
    const main = el({ tag: "main" });
    const p = el({ tag: "p", parent: main, prevSiblings: ["P", "P"] });
    expect(buildCssSelector(p)).toBe("main > p:nth-of-type(3)");
  });

  it("does not add :nth-of-type when only different-tag siblings precede", () => {
    const main = el({ tag: "main" });
    const p = el({ tag: "p", parent: main, prevSiblings: ["H1", "H2"] });
    expect(buildCssSelector(p)).toBe("main > p");
  });

  it("stops the walk at an element with an id", () => {
    const root = el({ tag: "div", id: "root" });
    const inner = el({ tag: "span", parent: root });
    expect(buildCssSelector(inner)).toBe("#root > span");
  });

  it("includes a single class when no id and parent provides no anchor", () => {
    const root = el({ tag: "body" });
    const c = el({ tag: "div", classes: ["card"], parent: root });
    expect(buildCssSelector(c)).toBe("body > div.card");
  });

  it("ignores empty classList safely", () => {
    const root = el({ tag: "body" });
    const c = el({ tag: "div", parent: root });
    expect(buildCssSelector(c)).toBe("body > div");
  });
});

// ---------------------------------------------------------------------------
// composePayload — pure builder.
// ---------------------------------------------------------------------------

describe("composePayload", () => {
  it("builds a payload with all expected keys", () => {
    const p = composePayload({
      url: "https://example.com/x",
      title: "X",
      selector: "main > p",
      tagName: "P",
      text: "hello",
      capturedAt: "2026-05-22T12:00:00.000Z",
    });
    expect(p).toEqual({
      url: "https://example.com/x",
      title: "X",
      selector: "main > p",
      tagName: "P",
      text: "hello",
      capturedAt: "2026-05-22T12:00:00.000Z",
    });
  });

  it("omits undefined optional fields rather than sending nulls", () => {
    const p = composePayload({
      url: "https://example.com/y",
      text: "hello",
      capturedAt: "2026-05-22T12:00:00.000Z",
    });
    expect(p).toEqual({
      url: "https://example.com/y",
      text: "hello",
      capturedAt: "2026-05-22T12:00:00.000Z",
    });
    expect("title" in p).toBe(false);
    expect("selector" in p).toBe(false);
  });

  it("trims a whitespace-only title to undefined (server treats it as missing)", () => {
    const p = composePayload({
      url: "https://example.com/y",
      title: "   ",
      text: "hello",
      capturedAt: "2026-05-22T12:00:00.000Z",
    });
    expect("title" in p).toBe(false);
  });
});
