import { beforeEach, describe, expect, it, vi } from "vitest";

const getOrCreateAgentThreadMock = vi.fn();
const getAgentConfigMock = vi.fn();
const runAgentTurnMock = vi.fn();
const createAutomationActivityMock = vi.fn();
const finalizeAutomationActivityMock = vi.fn();
const updateAutomationActivityMock = vi.fn();
const publishNotificationMock = vi.fn();

vi.mock("@/lib/stores/threads", () => ({
  getOrCreateAgentThread: (...args: unknown[]) => getOrCreateAgentThreadMock(...args),
}));
vi.mock("@/lib/stores/agent-configs", () => ({
  getAgentConfig: (...args: unknown[]) => getAgentConfigMock(...args),
}));
vi.mock("@/lib/agents/agent-turn", () => ({
  runAgentTurn: (...args: unknown[]) => runAgentTurnMock(...args),
}));
vi.mock("@/lib/stores/automation-activity", () => ({
  createAutomationActivity: (...args: unknown[]) => createAutomationActivityMock(...args),
  finalizeAutomationActivity: (...args: unknown[]) => finalizeAutomationActivityMock(...args),
  updateAutomationActivity: (...args: unknown[]) => updateAutomationActivityMock(...args),
}));
vi.mock("@/lib/notifications/bus", () => ({
  publish: (...args: unknown[]) => publishNotificationMock(...args),
}));

const { runTriggerAgent } = await import("./runner");

describe("runTriggerAgent", () => {
  beforeEach(() => {
    getOrCreateAgentThreadMock.mockReset();
    getAgentConfigMock.mockReset();
    runAgentTurnMock.mockReset();
    createAutomationActivityMock.mockReset();
    finalizeAutomationActivityMock.mockReset();
    updateAutomationActivityMock.mockReset();
    publishNotificationMock.mockReset();

    getAgentConfigMock.mockReturnValue({ id: "agent-1" });
    getOrCreateAgentThreadMock.mockReturnValue({ thread_id: "thread-1" });
    createAutomationActivityMock.mockReturnValue({ msg_id: "activity-1" });
  });

  it("marks a terminal agent failure as failed", async () => {
    runAgentTurnMock.mockRejectedValue(new Error("Provider connection failed"));

    const outcome = await runTriggerAgent({
      id: "task-1",
      kind: "scheduled_task",
      mode: "prompt",
      agentId: "agent-1",
      prompt: "Check status",
    });

    expect(outcome).toEqual({
      status: "error",
      preview: "",
      threadId: "thread-1",
      error: "Provider connection failed",
    });
    expect(finalizeAutomationActivityMock).toHaveBeenCalledWith(
      "activity-1",
      { disposition: "failed", error: "Provider connection failed" },
    );
  });
});
