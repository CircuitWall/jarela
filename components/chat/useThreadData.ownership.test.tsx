// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadData } from "./useThreadData";

const mocks = vi.hoisted(() => ({ get: vi.fn(), pin: vi.fn() }));
vi.mock("@/api/client", () => ({
  api: { threads: { get: mocks.get, setContextPin: mocks.pin } },
}));

function detail() {
  return {
    messages: [], has_more: false, hot_since: "2026-10-10",
    hot_since_seq: 10, warm_summary: "warm", warm_summary_before: "2026-10-10",
    warm_summary_before_seq: 10, warm_summary_computed_at: "2026-10-10",
    warm_summary_source_messages: 4, warm_summary_source_chars: 40,
    warm_summary_topics: null, warm_channel_summaries: [],
    pending_hot_since_seq: null, context_window_tokens: 8192,
  };
}

beforeEach(() => vi.resetAllMocks());

describe("thread metadata owner", () => {
  it("resets every metadata field together when deselecting a thread", async () => {
    mocks.get.mockResolvedValue(detail());
    const attach = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) => useThreadData({ threadId, attach }),
      { initialProps: { threadId: "thread-a" as string | null } },
    );
    await waitFor(() => expect(result.current.warmSummary).toBe("warm"));
    const applier = result.current.metaApplier;
    rerender({ threadId: null });
    expect(result.current.metaApplier).toBe(applier);
    expect(result.current).toMatchObject({
      hotSince: null, hotSinceSeq: null, warmSummary: null,
      warmSummaryBefore: null, warmSummaryBeforeSeq: null,
      warmSummaryComputedAt: null, warmSummarySourceMessages: null,
      warmSummarySourceChars: null, warmSummaryTopics: null,
      warmChannelSummaries: [], warmSummaryPending: false,
      compactionPending: false, manualCompactionPending: false,
      contextWindowTokens: null, messagesLoading: false,
    });
  });

  it("preserves the committed summary while a replacement pin is pending", async () => {
    mocks.get.mockResolvedValue(detail());
    mocks.pin.mockResolvedValue({ ...detail(), pending_hot_since_seq: 20 });
    const attach = vi.fn(async () => undefined);
    const { result } = renderHook(() => useThreadData({ threadId: "thread-a", attach }));
    await waitFor(() => expect(result.current.hotSinceSeqForRun).toBe(10));
    await act(async () => result.current.setContextPin(20));
    expect(result.current.hotSinceSeqForRun).toBe(10);
    expect(result.current.warmSummary).toBe("warm");
    expect(result.current.compactionPending).toBe(true);
    expect(mocks.pin).toHaveBeenCalledWith("thread-a", 20);
  });

  it("does not apply or attach an abandoned history request", async () => {
    let resolve!: (value: ReturnType<typeof detail>) => void;
    mocks.get.mockReturnValue(new Promise((done) => { resolve = done; }));
    const attach = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) => useThreadData({ threadId, attach }),
      { initialProps: { threadId: "thread-a" as string | null } },
    );
    rerender({ threadId: null });
    await act(async () => resolve(detail()));
    expect(attach).not.toHaveBeenCalled();
    expect(result.current.warmSummary).toBeNull();
    expect(result.current.messagesThreadId).toBeNull();
  });
});
