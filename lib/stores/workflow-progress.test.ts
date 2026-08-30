import { describe, expect, it } from "vitest";
import {
  completeWorkflow,
  mergeWorkflowProgress,
  startWorkflow,
  updateWorkflowItem,
  type WorkflowState,
} from "./workflow-progress";

function baseState(): WorkflowState<"phase_1" | "phase_2" | "complete"> {
  return {
    phase: null,
    summary: "ready",
    error: null,
    checklist: [
      { id: "one", label: "First", status: "pending", reason: "first reason", affected_files: [] },
      { id: "two", label: "Second", status: "pending", reason: "second reason", affected_files: [] },
    ],
  };
}

describe("workflow progress helpers", () => {
  it("starts a workflow without mutating the original state", () => {
    const original = baseState();
    const next = startWorkflow(original, "phase_1");

    expect(next.phase).toBe("phase_1");
    expect(original.phase).toBeNull();
  });

  it("updates a single checklist item", () => {
    const next = updateWorkflowItem(baseState(), "one", "checking");

    expect(next.checklist.map((item) => [item.id, item.status])).toEqual([
      ["one", "checking"],
      ["two", "pending"],
    ]);
  });

  it("does not regress completed items back to checking", () => {
    const done = updateWorkflowItem(baseState(), "one", "done");
    const next = updateWorkflowItem(done, "one", "checking");

    expect(next.checklist[0].status).toBe("done");
  });

  it("marks pending and checking items done when completing", () => {
    const running = updateWorkflowItem(baseState(), "one", "checking");
    const next = completeWorkflow(running, "complete");

    expect(next.phase).toBe("complete");
    expect(next.checklist.every((item) => item.status === "done")).toBe(true);
  });

  it("merges phase, item, summary, and error updates", () => {
    const result = mergeWorkflowProgress(baseState(), {
      phase: "phase_2",
      item_id: "two",
      status: "needs_attention",
      summary: "attention needed",
      error: "manual review required",
    });

    expect(result.updated_item_id).toBe("two");
    expect(result.state).toMatchObject({
      phase: "phase_2",
      summary: "attention needed",
      error: "manual review required",
    });
    expect(result.state.checklist[1].status).toBe("needs_attention");
  });

  it("rejects unknown checklist items", () => {
    expect(() => updateWorkflowItem(baseState(), "missing", "done")).toThrow(/not found/);
  });
});