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

  it("pretty-prints valid JSON in preview mode", () => {
    render(<MarkdownTextarea value='{"name":"Jarela","enabled":true}' onChange={() => undefined} />);

    expect(screen.getByText(/"name": "Jarela"/)).toBeTruthy();
    expect(screen.getByText(/"enabled": true/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});