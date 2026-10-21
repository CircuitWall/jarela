// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryValuePreview } from "./MemoryValuePreview";

describe("MemoryValuePreview", () => {
  it("shows a structured memory summary instead of the JSON fields", () => {
    render(
      <MemoryValuePreview
        value={{
          version: 2,
          subject: "Favorite editor",
          summary: "Prefers using VS Code",
          content: "The user prefers editing code in VS Code.",
        }}
      />,
    );

    expect(screen.getByText("Prefers using VS Code")).toBeTruthy();
    expect(screen.queryByText(/version:|subject:|content:/)).toBeNull();
  });

  it("falls back to the record content when there is no summary", () => {
    render(<MemoryValuePreview value={{ subject: "Favorite editor", content: "Prefers VS Code." }} />);

    expect(screen.getByText("Prefers VS Code.")).toBeTruthy();
    expect(screen.queryByText(/subject:/)).toBeNull();
  });
});
