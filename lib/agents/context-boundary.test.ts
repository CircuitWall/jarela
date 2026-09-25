import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  thread: { message_count: 12, hot_since: "2026-09-25T10:00:00.000Z" } as { message_count: number; hot_since: string | null },
  scheduled: [] as Array<{ threadId: string; boundary: string; lock: number | undefined }>,
  directPins: [] as Array<string | null>,
}));

vi.mock("@/lib/stores/threads", () => ({
  getThread: () => state.thread,
  setThreadContextPin: (_threadId: string, pin: string | null) => {
    state.directPins.push(pin);
    state.thread.hot_since = pin;
  },
  setAutoBoundaryLock: () => {},
}));
vi.mock("@/lib/agents/warm-summary-background", () => ({
  kickBoundaryCompaction: (threadId: string, boundary: string, options: { autoBoundaryLockedUntilMessageCount?: number }) => {
    state.scheduled.push({ threadId, boundary, lock: options.autoBoundaryLockedUntilMessageCount });
  },
}));

import { moveThreadContextBoundary } from "./context-boundary";

describe("moveThreadContextBoundary", () => {
  beforeEach(() => {
    state.thread = { message_count: 12, hot_since: "2026-09-25T10:00:00.000Z" };
    state.scheduled = [];
    state.directPins = [];
  });

  it("defers a non-null manual boundary until compaction can publish its summary", () => {
    const result = moveThreadContextBoundary("thread-1", "2026-09-25T11:00:00.000Z", { refreshWarmSummary: true });

    expect(state.directPins).toEqual([]);
    expect(state.thread.hot_since).toBe("2026-09-25T10:00:00.000Z");
    expect(state.scheduled).toEqual([{
      threadId: "thread-1",
      boundary: "2026-09-25T11:00:00.000Z",
      lock: 22,
    }]);
    expect(result?.hot_since).toBe("2026-09-25T10:00:00.000Z");
  });

  it("clears a boundary immediately because no replacement summary is needed", () => {
    moveThreadContextBoundary("thread-1", null);

    expect(state.scheduled).toEqual([]);
    expect(state.directPins).toEqual([null]);
    expect(state.thread.hot_since).toBeNull();
  });
});