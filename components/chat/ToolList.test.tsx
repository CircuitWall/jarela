// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolList, type ToolEvent } from "./ToolList";

describe("ToolList — live progress (ADR-0073)", () => {
  it("shows the latest progress step inline while the call is running", () => {
    const events: ToolEvent[] = [
      { id: "c1", phase: "call", name: "claude_delegate", payload: { task: "x" } },
      { id: "c1", phase: "progress", name: "claude_delegate", payload: "Claude: looking at the code" },
      { id: "c1", phase: "progress", name: "claude_delegate", payload: "→ Read: a.ts" },
    ];
    render(<ToolList events={events} />);
    expect(screen.getByText("→ Read: a.ts")).toBeTruthy();
    // Only the latest step shows inline (collapsed) — the earlier one is
    // only visible once expanded.
    expect(screen.queryByText("Claude: looking at the code")).toBeNull();
  });

  it("renders the step count instead of the synthetic wallclock bar once progress arrives", () => {
    const events: ToolEvent[] = [
      { id: "c1", phase: "call", name: "claude_delegate", payload: { task: "x" } },
      { id: "c1", phase: "progress", name: "claude_delegate", payload: "step 1" },
      { id: "c1", phase: "progress", name: "claude_delegate", payload: "step 2" },
    ];
    render(<ToolList events={events} />);
    expect(screen.getByLabelText("2 steps so far")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("still shows the synthetic wallclock bar for calls that never report progress", () => {
    const events: ToolEvent[] = [
      { id: "c1", phase: "call", name: "local_exec", payload: { command: "ls" } },
    ];
    render(<ToolList events={events} />);
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("expanding the card shows the full step history, joined one per line", () => {
    const events: ToolEvent[] = [
      { id: "c1", phase: "call", name: "claude_delegate", payload: { task: "x" } },
      { id: "c1", phase: "progress", name: "claude_delegate", payload: "step 1" },
      { id: "c1", phase: "progress", name: "claude_delegate", payload: "step 2" },
    ];
    const { container } = render(<ToolList events={events} />);
    fireEvent.click(screen.getByText("claude_delegate"));
    expect(screen.getByText("live steps (2)")).toBeTruthy();
    expect(container.querySelector("pre")?.textContent).toBe("step 1\nstep 2");
  });

  it("stops showing the inline preview once the call resolves", () => {
    const events: ToolEvent[] = [
      { id: "c1", phase: "call", name: "claude_delegate", payload: { task: "x" } },
      { id: "c1", phase: "progress", name: "claude_delegate", payload: "step 1" },
      { id: "c1", phase: "result", name: "claude_delegate", payload: { ok: true } },
    ];
    render(<ToolList events={events} />);
    expect(screen.queryByText("step 1")).toBeNull();
  });
});
