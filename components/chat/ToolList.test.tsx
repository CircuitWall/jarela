// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolList, type ToolEvent } from "./ToolList";

describe("ToolList — live progress (ADR-0073)", () => {
  it("shows the full step history inline, one row per step, while the call is running", () => {
    const events: ToolEvent[] = [
      { id: "c1", phase: "call", name: "claude_delegate", payload: { task: "x" } },
      { id: "c1", phase: "progress", name: "claude_delegate", payload: "Claude: looking at the code" },
      { id: "c1", phase: "progress", name: "claude_delegate", payload: "→ Read: a.ts" },
    ];
    render(<ToolList events={events} />);
    // The nested live transcript renders every step as its own row, not
    // just the latest one — no need to expand the card to see history.
    expect(screen.getByText("Claude: looking at the code")).toBeTruthy();
    expect(screen.getByText("Read: a.ts")).toBeTruthy();
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

  it("shows every step without needing to expand the card, and no 'read more' below the row cap", () => {
    const events: ToolEvent[] = [
      { id: "c1", phase: "call", name: "claude_delegate", payload: { task: "x" } },
      { id: "c1", phase: "progress", name: "claude_delegate", payload: "step 1" },
      { id: "c1", phase: "progress", name: "claude_delegate", payload: "step 2" },
    ];
    render(<ToolList events={events} />);
    expect(screen.getByText("step 1")).toBeTruthy();
    expect(screen.getByText("step 2")).toBeTruthy();
    expect(screen.queryByText("read more")).toBeNull();
  });

  it("offers 'read more' once the transcript overflows its capped height, and expands on click", () => {
    // jsdom never computes real layout — scrollHeight/clientHeight are 0
    // for every element — so overflow has to be stubbed to exercise the
    // "read more" branch at all.
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", { configurable: true, value: 300 });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", { configurable: true, value: 112 });
    try {
      const events: ToolEvent[] = Array.from({ length: 20 }, (_, i) => ({
        id: "c1",
        phase: "progress" as const,
        name: "claude_delegate",
        payload: `step ${i}`,
      }));
      events.unshift({ id: "c1", phase: "call", name: "claude_delegate", payload: { task: "x" } });
      render(<ToolList events={events} />);
      const readMore = screen.getByText("read more");
      expect(readMore).toBeTruthy();
      fireEvent.click(readMore);
      expect(screen.getByText("show less")).toBeTruthy();
    } finally {
      Reflect.deleteProperty(HTMLDivElement.prototype, "scrollHeight");
      Reflect.deleteProperty(HTMLDivElement.prototype, "clientHeight");
    }
  });

  it("keeps the transcript visible after the call resolves", () => {
    const events: ToolEvent[] = [
      { id: "c1", phase: "call", name: "claude_delegate", payload: { task: "x" } },
      { id: "c1", phase: "progress", name: "claude_delegate", payload: "step 1" },
      { id: "c1", phase: "result", name: "claude_delegate", payload: { ok: true } },
    ];
    render(<ToolList events={events} />);
    expect(screen.getByText("step 1")).toBeTruthy();
  });
});
