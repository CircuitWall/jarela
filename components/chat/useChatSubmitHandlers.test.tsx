// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatSubmitHandlers } from "./useChatSubmitHandlers";
import type { ChatQueueApi } from "./useChatQueue";
import type { PendingAction } from "@/api/types";

const action: PendingAction = {
  id: "proposal-example", agent_id: "agent-example", kind: "ask_choice",
  payload: {}, reason: null, status: "approved", result: { selected_values: ["brief"] },
  created_at: "2026-10-29T18:00:00Z", decided_at: "2026-10-29T18:01:00Z",
};

function setup(ready: boolean) {
  const queue: ChatQueueApi = {
    queue: [], queueRef: { current: [] }, drainQueueRef: { current: vi.fn() },
    isReady: () => ready, enqueue: vi.fn(), prepend: vi.fn(), removeQueued: vi.fn(), retry: vi.fn(),
  };
  const params: Parameters<typeof useChatSubmitHandlers>[0] = {
    agentId: action.agent_id, queue, attachments: [{ type: "text", text: "Unrelated composer attachment" }],
    setAttachments: vi.fn(), launchRun: vi.fn().mockResolvedValue(undefined),
    steerRun: vi.fn(), stopStreaming: vi.fn(), streaming: !ready,
    onCompact: vi.fn(), pendingAutoSpeakRef: { current: false }, agentConfig: null,
  };
  const hook = renderHook(() => useChatSubmitHandlers(params));
  return { ...hook, params, queue };
}

describe("proposal response chat continuation", () => {
  it("starts a user turn when idle without consuming composer attachments", async () => {
    const { result, params } = setup(true);
    await act(() => result.current.handleProposalResolved(action));
    expect(params.launchRun).toHaveBeenCalledWith(expect.stringContaining(action.id), []);
    expect(params.launchRun).toHaveBeenCalledWith(expect.stringContaining("does not approve any separate change"), []);
    expect(params.setAttachments).not.toHaveBeenCalled();
    expect(params.stopStreaming).not.toHaveBeenCalled();
  });

  it("queues a response without interrupting an active run", async () => {
    const { result, params, queue } = setup(false);
    await act(() => result.current.handleProposalResolved(action));
    expect(queue.enqueue).toHaveBeenCalledWith(expect.stringContaining("check_proposal"), []);
    expect(params.launchRun).not.toHaveBeenCalled();
    expect(params.stopStreaming).not.toHaveBeenCalled();
  });

  it("does not continue the wrong agent's conversation", async () => {
    const { result, params, queue } = setup(true);
    await expect(result.current.handleProposalResolved({ ...action, agent_id: "other-agent" })).rejects.toThrow("different agent");
    expect(params.launchRun).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
