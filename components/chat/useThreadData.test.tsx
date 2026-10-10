// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getThread: vi.fn() }));

vi.mock("@/api/client", () => ({
  api: { threads: { get: (...args: unknown[]) => mocks.getThread(...args) } },
}));

const { useThreadData } = await import("./useThreadData");

function threadDetail(hotSinceSeq: number | null) {
  return {
    messages: [],
    has_more: false,
    hot_since: hotSinceSeq === null ? null : "2026-10-10T08:00:00.000Z",
    hot_since_seq: hotSinceSeq,
    warm_summary: null,
    warm_summary_before: null,
    warm_summary_before_seq: null,
    warm_summary_computed_at: null,
    warm_summary_source_messages: null,
    warm_summary_source_chars: null,
    warm_summary_topics: null,
    context_window_tokens: 8192,
  };
}

describe("useThreadData boundary ownership", () => {
  beforeEach(() => {
    mocks.getThread.mockReset();
  });

  it("does not expose the previous thread cursor while the next thread is loading", async () => {
    let resolveSecond!: (value: ReturnType<typeof threadDetail>) => void;
    mocks.getThread.mockImplementation((threadId: string) => {
      if (threadId === "thread-a") return Promise.resolve(threadDetail(41));
      return new Promise((resolve) => { resolveSecond = resolve; });
    });
    const attach = vi.fn(async () => undefined);

    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string }) => useThreadData({ threadId, attach }),
      { initialProps: { threadId: "thread-a" } },
    );
    await waitFor(() => expect(result.current.hotSinceSeqForRun).toBe(41));

    rerender({ threadId: "thread-b" });
    expect(result.current.hotSinceSeq).toBeNull();
    expect(result.current.hotSinceSeqForRun).toBeUndefined();

    await act(async () => resolveSecond(threadDetail(7)));
    await waitFor(() => expect(result.current.hotSinceSeqForRun).toBe(7));
  });
});
