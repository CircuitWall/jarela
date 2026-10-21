// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryEditor } from "./MemoryEditor";

describe("MemoryEditor", () => {
  it("opens a wide dialog with a tall JSON editor", () => {
    render(<MemoryEditor onSave={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByRole("dialog").className).toContain("max-w-2xl");
    expect(screen.getByPlaceholderText('{"key": "value"}').className).toContain("h-[50vh]");
  });
});
