// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { MarkdownContent } from "./MessageContent";

describe("MarkdownContent links", () => {
  it("opens an external link in a new window", () => {
    render(<MarkdownContent text="See [the docs](https://example.com/docs)." />);

    const link = screen.getByRole("link", { name: "the docs" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("enlarges an image in place instead of following the link around it", () => {
    render(<MarkdownContent text="[![chart](https://example.com/chart.png)](https://example.com/page)" />);

    const image = screen.getByRole("img", { name: "chart" });
    const click = createEvent.click(image);
    fireEvent(image, click);

    expect(click.defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
