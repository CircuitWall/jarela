// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkflowRunner } from "./WorkflowRunner";
import type { WorkflowRun } from "@/api/types";

const state = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), mutate: vi.fn() }));
vi.mock("@/api/client", () => ({ api: {
  agents: { list: async () => [{ id: "synthetic-agent", name: "Synthetic agent" }] },
  workflows: state,
} }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function run(): WorkflowRun {
  return {
    id: "synthetic-run", agentId: "synthetic-agent", revision: "synthetic-revision", version: 3,
    workspace: "C:\\synthetic", owner: { pid: 123, instanceId: "synthetic-owner" },
    phase: "waiting", next: 0, steps: [{ id: "review", attempts: 0, status: "pending" }],
    question: { stepId: "review", input: {}, outputSchema: { type: "object", properties: {}, additionalProperties: false }, executionApproval: false },
  };
}
describe("durable workflow controls", () => {
  it("submits a version-bound typed human answer, not an execution approval", async () => {
    const waiting = run();
    state.list.mockResolvedValue([waiting]);
    state.mutate.mockResolvedValue({ ...waiting, phase: "completed", version: 4, question: undefined });
    render(<WorkflowRunner />);
    await screen.findByRole("option", { name: "Synthetic agent" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh workflows" }));
    await screen.findByLabelText("Response JSON");
    expect(screen.getByText(/does NOT authorize script execution/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Response JSON"), { target: { value: '{ "approved": false }' } });
    fireEvent.click(screen.getByRole("button", { name: "Submit typed response" }));
    await waitFor(() => expect(state.mutate).toHaveBeenCalledWith("synthetic-run", {
      action: "answer", agentId: "synthetic-agent", version: 3, revision: "synthetic-revision",
      stepId: "review", answerJson: '{ "approved": false }',
    }));
    await screen.findByText(/completed.*version 4/);
  });

  it("retains pending-plan detail returned by advance and surfaces stale-version errors", async () => {
    const ready = { ...run(), phase: "ready" as const, question: undefined };
    state.list.mockResolvedValue([ready]);
    state.mutate.mockResolvedValueOnce({ ...ready, executionApproval: { kind: "approval_required", proposalId: "synthetic-proposal" } })
      .mockRejectedValueOnce(new Error("Stale workflow version"));
    render(<WorkflowRunner />);
    await screen.findByRole("option", { name: "Synthetic agent" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh workflows" }));
    await screen.findByRole("button", { name: "Resume / recover" });
    fireEvent.click(screen.getByRole("button", { name: "Resume / recover" }));
    await screen.findByText(/Script-plan approval is pending/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel workflow" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Stale workflow version");
  });
});
