// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadActivity } from "@/api/types";

const mocks = vi.hoisted(() => ({ activity: vi.fn(), getThread: vi.fn() }));

vi.mock("@/api/client", () => ({
  api: {
    threads: {
      activity: (...args: unknown[]) => mocks.activity(...args),
      get: (...args: unknown[]) => mocks.getThread(...args),
    },
  },
}));

const { useThreadActivity } = await import("./useThreadActivity");

const idle: ThreadActivity = { run: null, queue_depth: 0, compaction: null, busy: false };
const running: ThreadActivity = {
  run: { phase: "thinking", label: "Thinking…", started_at: 1, agent_id: "a" },
  queue_depth: 1,
  compaction: null,
  busy: true,
};
const compacting: ThreadActivity = {
  run: null,
  queue_depth: 0,
  compaction: { kind: "manual", boundary_seq: 4, started_at: 1, deadline_at: 2 },
  busy: true,
};

function metaApplier() {
  return {
    setHotSince: vi.fn(), setHotSinceSeq: vi.fn(), setWarmSummary: vi.fn(), setWarmSummaryBefore: vi.fn(),
    setWarmSummaryBeforeSeq: vi.fn(), setWarmSummaryComputedAt: vi.fn(), setWarmSummarySourceMessages: vi.fn(),
    setWarmSummarySourceChars: vi.fn(), setContextWindowTokens: vi.fn(), setWarmSummaryPending: vi.fn(),
    setCompactionPending: vi.fn(), setManualCompactionPending: vi.fn(), setWarmSummaryTopics: vi.fn(),
    setWarmChannelSummaries: vi.fn(),
  };
}

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("useThreadActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.activity.mockReset();
    mocks.getThread.mockReset();
    mocks.getThread.mockResolvedValue({ messages: [], has_more: false });
  });
  afterEach(() => vi.useRealTimers());

  it("attaches to a run started elsewhere when this client is not streaming", async () => {
    mocks.activity.mockResolvedValue(running);
    const attach = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useThreadActivity({
      threadId: "t1", attach, isLive: () => false, lastSettledAt: () => 0, metaApplier: metaApplier(),
    }));
    await tick(1_500);
    expect(attach).toHaveBeenCalledWith("t1");
  });

  it("does not attach while it owns a stream or right after one settled", async () => {
    mocks.activity.mockResolvedValue(running);
    const attach = vi.fn().mockResolvedValue(undefined);
    let live = true;
    renderHook(() => useThreadActivity({
      threadId: "t1", attach, isLive: () => live, lastSettledAt: () => Date.now(), metaApplier: metaApplier(),
    }));
    await tick(1_500);
    live = false;
    await tick(1_500);
    expect(attach).not.toHaveBeenCalled();
  });

  it("restores compaction flags and refreshes metadata once compaction ends", async () => {
    mocks.activity.mockResolvedValueOnce(compacting).mockResolvedValue(idle);
    const meta = metaApplier();
    const { result } = renderHook(() => useThreadActivity({
      threadId: "t1", attach: vi.fn(), isLive: () => false, lastSettledAt: () => 0, metaApplier: meta,
    }));
    await tick(1_500);
    expect(result.current?.compaction?.kind).toBe("manual");
    expect(meta.setCompactionPending).toHaveBeenCalledWith(true);
    expect(meta.setManualCompactionPending).toHaveBeenCalledWith(true);
    await tick(1_500);
    expect(mocks.getThread).toHaveBeenCalledWith("t1", { limit: 1 });
    expect(meta.setManualCompactionPending).toHaveBeenLastCalledWith(false);
  });

  it("clears compaction flags even if the metadata refresh fails", async () => {
    mocks.activity.mockResolvedValueOnce(compacting).mockResolvedValue(idle);
    mocks.getThread.mockRejectedValue(new Error("offline"));
    const meta = metaApplier();
    renderHook(() => useThreadActivity({
      threadId: "t1", attach: vi.fn(), isLive: () => false, lastSettledAt: () => 0, metaApplier: meta,
    }));
    await tick(3_000);
    expect(meta.setManualCompactionPending).toHaveBeenLastCalledWith(false);
    expect(meta.setCompactionPending).toHaveBeenLastCalledWith(false);
  });

  it("does not poll without a thread", async () => {
    renderHook(() => useThreadActivity({
      threadId: null, attach: vi.fn(), isLive: () => false, lastSettledAt: () => 0, metaApplier: metaApplier(),
    }));
    await tick(10_000);
    expect(mocks.activity).not.toHaveBeenCalled();
  });
});
