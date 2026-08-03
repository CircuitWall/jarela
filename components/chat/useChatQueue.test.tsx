// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatQueue } from "./useChatQueue";

describe("useChatQueue retry", () => {
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