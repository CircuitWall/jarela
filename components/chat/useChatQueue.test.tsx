// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatQueue } from "./useChatQueue";

describe("useChatQueue retry", () => {
  it("keeps hidden continuations separate from visible queued discussion in FIFO order", async () => {
    let finishFirst!: () => void;
    const launchRun = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishFirst = resolve;
    })).mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ streaming }) => useChatQueue({
      threadId: "thread-1", streaming, compacting: false, launchRun,
    }), { initialProps: { streaming: true } });
    const hidden = { messageMetadata: { hidden_from_chat: true } };
    await act(async () => {
      result.current.enqueue("First user question", []);
      result.current.enqueue("More user context", []);
      result.current.enqueue("Internal continuation", [], hidden);
      result.current.enqueue("Later user question", []);
    });
    rerender({ streaming: false });
    await waitFor(() => expect(launchRun).toHaveBeenCalledTimes(1));
    expect(launchRun).toHaveBeenNthCalledWith(1, "First user question\n\nMore user context", []);
    await act(async () => { result.current.drainQueueRef.current(); });
    expect(launchRun).toHaveBeenCalledTimes(1);
    await act(async () => { finishFirst(); });
    await waitFor(() => expect(launchRun).toHaveBeenCalledTimes(3));
    expect(launchRun).toHaveBeenNthCalledWith(2, "Internal continuation", [], hidden);
    expect(launchRun).toHaveBeenNthCalledWith(3, "Later user question", []);
    expect(result.current.queue).toEqual([]);
  });

  it("preserves hidden metadata when a rejected submission is prepended", async () => {
    const launchRun = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ streaming }) => useChatQueue({
      threadId: "thread-1", streaming, compacting: false, launchRun,
    }), { initialProps: { streaming: true } });
    const hidden = { messageMetadata: { hidden_from_chat: true } };
    await act(async () => {
      result.current.enqueue("User discussion", []);
      result.current.prepend("Internal continuation", [], hidden);
    });
    rerender({ streaming: false });
    await waitFor(() => expect(launchRun).toHaveBeenCalledTimes(2));
    expect(launchRun).toHaveBeenNthCalledWith(1, "Internal continuation", [], hidden);
    expect(launchRun).toHaveBeenNthCalledWith(2, "User discussion", []);
  });

  it("launches exactly one retry immediately when ready", async () => {
    const launchRun = vi.fn<(_: string, __: unknown[]) => Promise<void>>().mockResolvedValue();
    const { result } = renderHook(() => useChatQueue({
      threadId: "thread-1",
      streaming: false,
      compacting: false,
      launchRun,
    }));

    await act(async () => {
      result.current.retry("retry this", []);
    });

    expect(launchRun).toHaveBeenCalledTimes(1);
    expect(launchRun).toHaveBeenCalledWith("retry this", []);
    expect(result.current.queue).toEqual([]);
  });

  it("enqueues exactly one retry when not ready", async () => {
    const launchRun = vi.fn<(_: string, __: unknown[]) => Promise<void>>().mockResolvedValue();
    const { result } = renderHook(() => useChatQueue({
      threadId: "thread-1",
      streaming: true,
      compacting: false,
      launchRun,
    }));

    await act(async () => {
      result.current.retry("retry this", []);
    });

    expect(launchRun).not.toHaveBeenCalled();
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0]?.text).toBe("retry this");
  });
});