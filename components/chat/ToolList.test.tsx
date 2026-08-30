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

  it("renders persisted Claude transcript metadata, launch details, questions, and awaiting badge", () => {
    const events: ToolEvent[] = [
      {
        id: "c1",
        phase: "call",
        name: "claude_delegate",
        payload: { task: "Add a feature" },
      },
      {
        id: "c1",
        phase: "result",
        name: "claude_delegate",
        payload: {
          awaiting_answers: true,
          transcript: {
            parent_message: "Add a feature",
            claude_steps: ["Claude: inspecting files", "→ Read: app/page.tsx"],
            design_questions: ["Should this be global or workspace scoped?"],
            awaiting_user_answers: true,
            launch: {
              model: "sonnet",
              tools: "Read,Grep",
              permission_mode_used: "dontAsk",
              timeout_seconds: 600,
              sync_memory: "both",
            },
          },
        },
      },
    ];

    render(<ToolList events={events} />);

    expect(screen.getByText("asks")).toBeTruthy();
    expect(screen.getByText("Asked Claude")).toBeTruthy();
    expect(screen.getByText("Add a feature")).toBeTruthy();
    expect(screen.getByText("Started")).toBeTruthy();
    expect(screen.getByText("model sonnet · tools Read,Grep · permission dontAsk · 600s timeout · memory both")).toBeTruthy();
    expect(screen.getByText("Claude: inspecting files")).toBeTruthy();
    expect(screen.getByText("Read: app/page.tsx")).toBeTruthy();
    expect(screen.getByText("Claude questions")).toBeTruthy();
    expect(screen.getByText("Should this be global or workspace scoped?")).toBeTruthy();
  });

  it("renders the final nested transcript returned by claude_delegate_status", () => {
    const events: ToolEvent[] = [
      {
        id: "c1",
        phase: "call",
        name: "claude_delegate_status",
        payload: { job_id: "job-1" },
      },
      {
        id: "c1",
        phase: "result",
        name: "claude_delegate_status",
        payload: {
          status: "done",
          result: {
            awaiting_answers: true,
            transcript: {
              parent_message: "Continue with user answers",
              claude_steps: ["Claude: resumed with answers"],
              design_questions: ["Which migration strategy should I use?"],
              awaiting_user_answers: true,
              launch: {
                model: "opus",
                tools: "default",
                permission_mode_used: "acceptEdits",
                timeout_seconds: 900,
                background: true,
                sync_memory: false,
              },
            },
          },
        },
      },
    ];

    render(<ToolList events={events} />);

    expect(screen.getByText("asks")).toBeTruthy();
    expect(screen.getByText("Continue with user answers")).toBeTruthy();
    expect(screen.getByText("model opus · tools default · permission acceptEdits · 900s timeout · background · memory sync off")).toBeTruthy();
    expect(screen.getByText("Claude: resumed with answers")).toBeTruthy();
    expect(screen.getByText("Which migration strategy should I use?")).toBeTruthy();
  });

  it("renders workflow_progress as an expandable checklist", () => {
    const events: ToolEvent[] = [
      {
        id: "w1",
        phase: "call",
        name: "workflow_progress",
        payload: { workflow_id: "version_adoption", phase: "impact_radius" },
      },
      {
        id: "w1",
        phase: "result",
        name: "workflow_progress",
        payload: {
          ok: true,
          workflow_id: "version_adoption",
          state: {
            phase: "impact_radius",
            summary: "Fetching changes",
            checklist: [
              { id: "fetch-changes", label: "Fetch changes", status: "done" },
              { id: "build-todo-list", label: "Build todo list", status: "checking" },
            ],
          },
        },
      },
    ];

    render(<ToolList events={events} />);
    fireEvent.click(screen.getByText("workflow_progress"));

    expect(screen.getByText("workflow")).toBeTruthy();
    expect(screen.getAllByText("Fetching changes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Fetch changes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Build todo list").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("done")).toBeTruthy();
    expect(screen.getByLabelText("checking")).toBeTruthy();
  });
});
