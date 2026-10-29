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
const hiddenOptions = { messageMetadata: { hidden_from_chat: true } };

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
    expect(params.launchRun).toHaveBeenCalledWith(expect.stringContaining(action.id), [], hiddenOptions);
    expect(params.launchRun).toHaveBeenCalledWith(expect.stringContaining("does not approve any separate change"), [], hiddenOptions);
    expect(params.setAttachments).not.toHaveBeenCalled();
    expect(params.stopStreaming).not.toHaveBeenCalled();
  });

  it("queues a response without interrupting an active run", async () => {
    const { result, params, queue } = setup(false);
    await act(() => result.current.handleProposalResolved(action));
    expect(queue.enqueue).toHaveBeenCalledWith(expect.stringContaining("check_proposal"), [], hiddenOptions);
    expect(params.launchRun).not.toHaveBeenCalled();
    expect(params.stopStreaming).not.toHaveBeenCalled();
  });

  it("allows further discussion before a late answer starts a separate contextual turn", async () => {
    const { result, params } = setup(true);
    await act(() => result.current.handleSubmit("Never mind the report; discuss the schedule instead."));
    expect(params.launchRun).toHaveBeenNthCalledWith(1,
      "Never mind the report; discuss the schedule instead.", params.attachments);
    await act(() => result.current.handleProposalResolved(action));
    expect(params.launchRun).toHaveBeenNthCalledWith(2, expect.stringContaining(action.id), [], hiddenOptions);
    expect(params.launchRun).toHaveBeenNthCalledWith(2,
      expect.stringContaining("do not revive cancelled or superseded tasks"), [], hiddenOptions);
    expect(params.launchRun).toHaveBeenNthCalledWith(2,
      expect.stringContaining("original question/options, not the most recent question in chat"), [], hiddenOptions);
  });

  it("appends a delayed answer after already queued discussion without steering or aborting", async () => {
    const { result, params, queue } = setup(false);
    await act(() => result.current.handleQueue("Discuss the revised scope first."));
    await act(() => result.current.handleProposalResolved(action));
    expect(queue.enqueue).toHaveBeenNthCalledWith(1, "Discuss the revised scope first.", params.attachments);
    expect(queue.enqueue).toHaveBeenNthCalledWith(2, expect.stringContaining(action.id), [], hiddenOptions);
    expect(queue.prepend).not.toHaveBeenCalled();
    expect(params.steerRun).not.toHaveBeenCalled();
    expect(params.stopStreaming).not.toHaveBeenCalled();
  });

  it("shows a friendly queue label instead of internal continuation instructions", () => {
    const { result, queue, rerender } = setup(false);
    queue.queue = [{
      id: "internal-response", text: "Internal proposal instructions", attachments: [], options: hiddenOptions,
    }, { id: "user-message", text: "My next question", attachments: [] }];
    rerender();
    expect(result.current.queuedMessages.map((message) => message.text)).toEqual([
      "Continue after your response", "My next question",
    ]);
  });

  it("does not continue the wrong agent's conversation", async () => {
    const { result, params, queue } = setup(true);
    await expect(result.current.handleProposalResolved({ ...action, agent_id: "other-agent" })).rejects.toThrow("different agent");
    expect(params.launchRun).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
