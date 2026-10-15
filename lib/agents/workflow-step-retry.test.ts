import { describe, expect, it } from "vitest";
import {
  buildWorkflowStepRetryNudge,
  collectWorkflowContractFailures,
  planWorkflowStepRetries,
  WORKFLOW_STEP_MAX_ATTEMPTS,
  workflowProgressArgs,
} from "./workflow-step-retry";

const item = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, label: `Step ${id}`, input: "in", output: "out", validation: "check", status, ...extra,
});
const ok = (workflowId: string, checklist: unknown[], phase: string | null = null, error: string | null = null) =>
  JSON.stringify({ ok: true, workflow_id: workflowId, state: { phase, summary: "", error, checklist } });

describe("collectWorkflowContractFailures", () => {
  it("passes a workflow whose steps are verified or pending", () => {
    expect(collectWorkflowContractFailures([
      { args: { workflow_id: "w" }, result: ok("w", [item("a", "done", { validation_evidence: "ran" }), item("b", "pending")]) },
    ])).toEqual([]);
  });

  it("flags a rejected update and names the step that broke the contract", () => {
    const failures = collectWorkflowContractFailures([
      { args: { workflow_id: "w", items: [item("a", "done")] }, result: JSON.stringify({ ok: false, workflow_id: "w", error: "Every completed workflow item requires observed validation_evidence." }) },
    ]);
    expect(failures).toEqual([expect.objectContaining({ key: "w:a", itemId: "a", label: "Step a" })]);
    expect(failures[0].reason).toContain("validation_evidence");
  });

  it("clears a rejection once a later update for the same workflow is accepted", () => {
    expect(collectWorkflowContractFailures([
      { args: { workflow_id: "w", items: [item("a", "done")] }, result: { ok: false, workflow_id: "w", error: "x" } },
      { args: { workflow_id: "w" }, result: ok("w", [item("a", "done", { validation_evidence: "ran" })]) },
    ])).toEqual([]);
  });

  it("flags steps left checking or needing attention at turn end", () => {
    const failures = collectWorkflowContractFailures([
      { args: { workflow_id: "w" }, result: ok("w", [item("a", "checking"), item("b", "needs_attention")], null, "tests failed") },
    ]);
    expect(failures.map((f) => f.key)).toEqual(["w:a", "w:b"]);
    expect(failures[1].reason).toContain("tests failed");
  });

  it("does not retry steps that are waiting on the user", () => {
    expect(collectWorkflowContractFailures([
      { args: { workflow_id: "w" }, result: ok("w", [item("a", "needs_attention", { needs_user: true })]) },
      { args: { workflow_id: "version_adoption", item_id: "review-tools", status: "needs_attention", needs_user: true }, result: ok("version_adoption", [item("review-tools", "needs_attention")]) },
    ])).toEqual([]);
  });

  it("ignores completed workflows and reads invoke_tool envelopes", () => {
    expect(collectWorkflowContractFailures([
      { args: { workflow_id: "w" }, result: ok("w", [item("a", "checking")], "complete") },
    ])).toEqual([]);
    expect(collectWorkflowContractFailures([
      { args: { workflow_id: "w" }, result: { ok: true, tool: "workflow_progress", status: "done", result: ok("w", [item("a", "checking")]) } },
    ]).map((f) => f.key)).toEqual(["w:a"]);
  });
});

describe("workflowProgressArgs", () => {
  it("unwraps direct and proxied workflow_progress calls only", () => {
    expect(workflowProgressArgs("workflow_progress", { workflow_id: "w" })).toEqual({ workflow_id: "w" });
    expect(workflowProgressArgs("invoke_tool", { name: "workflow_progress", args_json: "{\"workflow_id\":\"w\"}" })).toEqual({ workflow_id: "w" });
    expect(workflowProgressArgs("invoke_tool", { name: "file_read", args_json: "{}" })).toBeNull();
    expect(workflowProgressArgs("file_read", { workflow_id: "w" })).toBeNull();
  });
});

describe("planWorkflowStepRetries", () => {
  const failure = { key: "w:a", workflowId: "w", itemId: "a", label: "Step a", reason: "r" };

  it(`allows ${WORKFLOW_STEP_MAX_ATTEMPTS} total attempts per step`, () => {
    expect(planWorkflowStepRetries([failure]).retry).toEqual([{ ...failure, attempt: 2 }]);
    expect(planWorkflowStepRetries([failure], { "w:a": 1 }).retry).toEqual([{ ...failure, attempt: 3 }]);
    const exhausted = planWorkflowStepRetries([failure], { "w:a": 2 });
    expect(exhausted.retry).toEqual([]);
    expect(exhausted.exhausted).toEqual([failure]);
  });
});

describe("buildWorkflowStepRetryNudge", () => {
  it("states the attempt, the failure, and the exact progress call for each workflow kind", () => {
    const nudge = buildWorkflowStepRetryNudge([
      { key: "w:a", workflowId: "w", itemId: "a", label: "Step a", reason: "validation failed", attempt: 2 },
      { key: "version_adoption:review-tools", workflowId: "version_adoption", itemId: "review-tools", label: "Review tools", reason: "left checking", attempt: 3 },
    ]);
    expect(nudge).toContain(`attempt 2 of ${WORKFLOW_STEP_MAX_ATTEMPTS}`);
    expect(nudge).toContain("complete items snapshot");
    expect(nudge).toContain('item_id: "review-tools"');
    expect(nudge).toContain("needs_user: true");
    expect(nudge).not.toMatch(/undefined|NaN|\[object Object\]/);
  });
});
