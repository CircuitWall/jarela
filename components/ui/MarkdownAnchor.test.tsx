// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownAnchor } from "./MarkdownAnchor";

describe("MarkdownAnchor", () => {
  it("opens external links in a new window", () => {
    render(<MarkdownAnchor href="https://example.com/docs">Docs</MarkdownAnchor>);

    const link = screen.getByRole("link", { name: "Docs" });
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps in-page anchors in the current window", () => {
    render(<MarkdownAnchor href="#msg-42">Jump</MarkdownAnchor>);

    const link = screen.getByRole("link", { name: "Jump" });
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("rel")).toBeNull();
  });

  it("keeps in-app routes in the current window", () => {
    render(<MarkdownAnchor href="/?tab=tools&item=browser">Capabilities</MarkdownAnchor>);

    const link = screen.getByRole("link", { name: "Capabilities" });
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("rel")).toBeNull();
  });

  it("does not leak react-markdown's node prop into the DOM", () => {
    render(<MarkdownAnchor href="https://example.com" node={{ type: "element" }}>Docs</MarkdownAnchor>);

    expect(screen.getByRole("link", { name: "Docs" }).hasAttribute("node")).toBe(false);
  });

  it("renders children without an anchor when there is no href", () => {
    const { container } = render(<MarkdownAnchor>Plain text</MarkdownAnchor>);

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("Plain text");
  });
});
