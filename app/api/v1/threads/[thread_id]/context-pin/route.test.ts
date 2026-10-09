import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  thread: {
    hot_since: null as string | null,
    hot_since_seq: null as number | null,
    warm_summary: null as string | null,
    warm_summary_before: null as string | null,
    warm_summary_before_seq: null as number | null,
  },
  source: { seq: 2, created_at: "2026-10-09T10:00:00.000Z" },
  moved: null as { threadId: string; boundarySeq: number | null; options: { refreshWarmSummary?: boolean } } | null,
}));

vi.mock("@/lib/stores/threads", () => ({
  getThread: () => state.thread,
  getThreadMessageBySeq: (_threadId: string, seq: number) => seq === state.source.seq ? state.source : null,
}));
vi.mock("@/lib/agents/context-boundary", () => ({
  moveThreadContextBoundary: (threadId: string, boundarySeq: number | null, options: { refreshWarmSummary?: boolean }) => {
    state.moved = { threadId, boundarySeq, options };
    state.thread = { ...state.thread, hot_since: boundarySeq === null ? null : state.source.created_at, hot_since_seq: boundarySeq };
    return state.thread;
  },
}));
vi.mock("@/lib/agents/warm-summary-background", () => ({
  pendingCompactionBoundary: () => null,
  pendingCompactionBoundarySeq: () => null,
}));
vi.mock("@/lib/agents/conversation-summary", () => ({ parseStoredTopics: () => null }));

import { PATCH } from "./route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/v1/threads/thread-1/context-pin", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/v1/threads/[thread_id]/context-pin", () => {
  beforeEach(() => {
    state.thread = {
      hot_since: null,
      hot_since_seq: null,
      warm_summary: null,
      warm_summary_before: null,
      warm_summary_before_seq: null,
    };
    state.moved = null;
  });

  it("passes the exact source seq for tied-time pins", async () => {
    const response = await PATCH(request({ hot_since_seq: 2 }), { params: Promise.resolve({ thread_id: "thread-1" }) });

    expect(response.status).toBe(200);
    expect(state.moved).toEqual({
      threadId: "thread-1",
      boundarySeq: 2,
      options: { refreshWarmSummary: true },
    });
    expect(await response.json()).toMatchObject({ hot_since: state.source.created_at, hot_since_seq: 2 });
  });

  it("rejects a sequence that is not owned by the requested thread", async () => {
    const response = await PATCH(request({ hot_since_seq: 999 }), { params: Promise.resolve({ thread_id: "thread-1" }) });

    expect(response.status).toBe(400);
    expect(state.moved).toBeNull();
  });

  it("rejects timestamp-only anchors", async () => {
    const response = await PATCH(request({ hot_since: "2026-10-09T10:00:00.000Z" }), { params: Promise.resolve({ thread_id: "thread-1" }) });

    expect(response.status).toBe(400);
    expect(state.moved).toBeNull();
  });
});