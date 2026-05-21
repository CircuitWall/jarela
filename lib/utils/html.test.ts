import { describe, it, expect } from "vitest";
import { stripHtml, decodeHtmlEntities } from "./html";

describe("stripHtml (default — collapse all whitespace)", () => {
  it("removes simple tags", () => {
    expect(stripHtml("<p>hello <b>world</b></p>")).toBe("hello world");
  });

  it("strips script blocks (and their contents)", () => {
    expect(stripHtml("a<script>evil()</script>b")).toBe("a b");
  });

  it("strips style blocks (and their contents)", () => {
    expect(stripHtml("a<style>.x{}</style>b")).toBe("a b");
  });

  it("strips noscript blocks", () => {
    expect(stripHtml("a<noscript>fallback</noscript>b")).toBe("a b");
  });

  it("strips HTML comments", () => {
    expect(stripHtml("a<!-- ignore -->b")).toBe("a b");
  });

  it("decodes common HTML entities", () => {
    expect(stripHtml("Tom &amp; Jerry &lt;3 &quot;x&quot; &#39;y&#39;&nbsp;end"))
      .toBe("Tom & Jerry <3 \"x\" 'y' end");
  });

  it("collapses whitespace runs to a single space", () => {
    expect(stripHtml("a    b\n\n\nc")).toBe("a b c");
  });

  it("trims leading/trailing whitespace", () => {
    expect(stripHtml("  <p>  hi  </p>  ")).toBe("hi");
  });

  it("handles empty input", () => {
    expect(stripHtml("")).toBe("");
  });
});

describe("stripHtml (preserveParagraphs: true)", () => {
  it("converts <br> to newline", () => {
    expect(stripHtml("a<br>b<br/>c", { preserveParagraphs: true })).toBe("a\nb\nc");
  });

  it("converts </p> to double newline", () => {
    expect(stripHtml("<p>a</p><p>b</p>", { preserveParagraphs: true })).toBe("a\n\nb");
  });

  it("collapses runs of 3+ newlines to 2 (paragraph breaks)", () => {
    expect(stripHtml("a<br><br><br><br>b", { preserveParagraphs: true })).toBe("a\n\nb");
  });

  it("collapses spaces/tabs but preserves single newlines", () => {
    expect(stripHtml("a  b\nc\td", { preserveParagraphs: true })).toBe("a b\nc d");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes &amp;, &lt;, &gt;, &quot;, &#39;, &nbsp;", () => {
    expect(decodeHtmlEntities("&amp;&lt;&gt;&quot;&#39;&nbsp;")).toBe("&<>\"' ");
  });

  it("leaves unknown entities alone", () => {
    expect(decodeHtmlEntities("&unknownentity;")).toBe("&unknownentity;");
  });
});
