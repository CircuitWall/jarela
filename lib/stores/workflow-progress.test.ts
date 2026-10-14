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
    const done = updateWorkflowItem(baseState(), "one", "done", "The focused test passed");
    const next = updateWorkflowItem(done, "one", "checking");

    expect(next.checklist[0].status).toBe("done");
    expect(next.checklist[0].validation_evidence).toBe("The focused test passed");
  });

  it("requires validation evidence when completing an item", () => {
    expect(() => updateWorkflowItem(baseState(), "one", "done")).toThrow(/validation evidence/);
    expect(mergeWorkflowProgress(baseState(), {
      item_id: "one",
      status: "done",
      validation_evidence: "The focused test passed",
    }).state.checklist[0]).toMatchObject({
      status: "done",
      validation_evidence: "The focused test passed",
    });
  });

  it("marks pending and checking items done when completing", () => {
    const running = updateWorkflowItem(baseState(), "one", "checking");
    const next = completeWorkflow(running, "complete", "User confirmed the checklist after reviewing each result");

    expect(next.phase).toBe("complete");
    expect(next.checklist.every((item) => item.status === "done")).toBe(true);
    expect(next.checklist.every((item) => Boolean(item.validation_evidence))).toBe(true);
  });

  it("refuses completion without evidence for already-completed checklist items", () => {
    const doneWithoutEvidence: WorkflowState<"phase_1" | "phase_2" | "complete"> = {
      ...baseState(),
      checklist: [{ ...baseState().checklist[0], status: "done" }],
    };
    expect(() => completeWorkflow(doneWithoutEvidence, "complete", "Checklist reviewed"))
      .toThrow(/marked done without validation evidence/);
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