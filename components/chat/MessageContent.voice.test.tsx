// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownContent } from "./MessageContent";

describe("MarkdownContent voice directives", () => {
  it("hides the tone marker and vocal tags from the rendered message", () => {
    render(<MarkdownContent text={"[[tone: warm and reassuring]]\n\nHere is <short pause> the summary."} />);

    expect(document.body.textContent).toContain("Here is the summary.");
    expect(document.body.textContent).not.toContain("[[tone:");
    expect(document.body.textContent).not.toContain("warm and reassuring");
    expect(document.body.textContent).not.toContain("<short pause>");
  });

  it("leaves ordinary square brackets and code untouched", () => {
    render(<MarkdownContent text={"See [1](https://example.test) and `<div>`, plus [[not a tone]]."} />);

    expect(document.body.textContent).toContain("[[not a tone]]");
    expect(document.body.textContent).toContain("<div>");
  });
});
