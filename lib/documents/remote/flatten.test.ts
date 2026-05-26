import { describe, it, expect } from "vitest";
import { adfToText, htmlToText } from "./flatten";

describe("htmlToText", () => {
  it("strips tags and decodes common entities", () => {
    const html = `<p>Hello &amp; <strong>world</strong>.</p><p>Line&nbsp;two.</p>`;
    expect(htmlToText(html)).toBe("Hello & world.\nLine two.");
  });

  it("drops script and style content entirely", () => {
    const html = `<p>keep me</p><script>secret()</script><style>.x{color:red}</style>`;
    expect(htmlToText(html).toLowerCase()).toContain("keep me");
    expect(htmlToText(html).toLowerCase()).not.toContain("secret");
    expect(htmlToText(html).toLowerCase()).not.toContain("color:red");
  });

  it("converts list items to separate lines", () => {
    const html = `<ul><li>a</li><li>b</li><li>c</li></ul>`;
    const lines = htmlToText(html).split("\n").filter(Boolean);
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("preserves CDATA content from Confluence macros", () => {
    const html = `<p><![CDATA[keep this code]]></p>`;
    expect(htmlToText(html)).toContain("keep this code");
  });

  it("returns empty string for empty input", () => {
    expect(htmlToText("")).toBe("");
  });
});

describe("adfToText", () => {
  it("flattens a simple paragraph ADF tree", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello world." }],
        },
      ],
    };
    expect(adfToText(adf)).toBe("Hello world.");
  });

  it("separates blocks with blank lines", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First." }] },
        { type: "paragraph", content: [{ type: "text", text: "Second." }] },
      ],
    };
    const txt = adfToText(adf);
    expect(txt).toContain("First.");
    expect(txt).toContain("Second.");
    expect(txt).toMatch(/First\.\s*\n\s*\n\s*Second\./);
  });

  it("handles nested lists", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "alpha" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "beta" }] }] },
          ],
        },
      ],
    };
    const txt = adfToText(adf);
    expect(txt).toContain("alpha");
    expect(txt).toContain("beta");
  });

  it("returns empty string for null/garbage input", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
    expect(adfToText("not-an-object")).toBe("");
  });
});
