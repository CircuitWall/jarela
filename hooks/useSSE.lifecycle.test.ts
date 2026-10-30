// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSSE } from "./useSSE";

const mocks = vi.hoisted(() => ({ submit: vi.fn(), subscribe: vi.fn(), abort: vi.fn() }));
vi.mock("@/api/client", () => ({
  submitRun: mocks.submit,
  subscribeRun: mocks.subscribe,
  api: { threads: { abortRun: mocks.abort } },
}));
vi.mock("@/lib/ui/loading", () => ({
  pushActivity: () => ({ set: vi.fn(), setInflightTools: vi.fn(), clear: vi.fn() }),
}));

describe("stream lifecycle ownership", () => {
  it("keeps start and attach stable across buffer and settled-state updates", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.submit.mockResolvedValue({ accepted: true });
    mocks.subscribe.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield JSON.stringify({ type: "text_delta", delta: "reply" });
        await gate;
        yield JSON.stringify({ type: "done" });
      },
    });
    const onDone = vi.fn();
    const { result } = renderHook(() => useSSE(onDone));
    const { start, attach } = result.current;
    let run!: ReturnType<typeof start>;
    try {
      act(() => { run = start("thread-a", "hello"); });
      await waitFor(() => expect(result.current.streamingContent).toBe("reply"));
      expect(result.current.start).toBe(start);
      expect(result.current.attach).toBe(attach);
      expect(result.current.isLive()).toBe(true);
      await act(async () => { release(); await run; });
      expect(result.current.start).toBe(start);
      expect(result.current.attach).toBe(attach);
      expect(result.current.streaming).toBe(false);
      expect(result.current.isLive()).toBe(false);
      expect(onDone).toHaveBeenCalledOnce();
    } finally {
      release();
      await act(async () => { await run; });
    }
  });
});
