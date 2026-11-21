// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownTextarea } from "./MarkdownTextarea";

describe("MarkdownTextarea", () => {
  it("starts in preview mode for Markdown content", () => {
    render(<MarkdownTextarea value="# Hello" onChange={() => undefined} />);

    expect(screen.getByRole("heading", { name: "Hello" })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("starts in edit mode when the value is empty", () => {
    render(<MarkdownTextarea value="" onChange={() => undefined} />);

    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("starts in edit mode when the value is only whitespace", () => {
    render(<MarkdownTextarea value={"   \n\t"} onChange={() => undefined} />);

    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("pretty-prints valid JSON in preview mode", () => {
    const { container } = render(
      <MarkdownTextarea value='{"name":"Jarela","enabled":true}' onChange={() => undefined} rows={4} />,
    );

    expect(screen.getByText(/"name": "Jarela"/)).toBeTruthy();
    expect(screen.getByText(/"enabled": true/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect((container.querySelector(".jarela-rich") as HTMLElement).style.minHeight).toBe("5rem");
  });

  it("opens preview links in a new window", () => {
    render(<MarkdownTextarea value="See [the docs](https://example.com/docs)." onChange={() => undefined} />);

    const link = screen.getByRole("link", { name: "the docs" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
});