import { describe, expect, it, vi } from "vitest";

const DEFAULT_ROWS = [
  { seq: 1, role: "user", content: "hello", created_at: "2026-09-25T10:00:00.000Z" },
  { seq: 2, role: "assistant", content: "hi", created_at: "2026-09-25T10:00:01.000Z" },
];

const state = vi.hoisted(() => ({
  thread: {
    thread_id: "thread-1",
    hot_since: null as string | null,
    warm_summary: null as string | null,
    warm_summary_before: null as string | null,
    message_count: 2,
  },
  commits: [] as Array<{ hotSince: string; summary: string }>,
  rows: [] as unknown[],
}));
state.rows = DEFAULT_ROWS;

vi.mock("@/lib/stores/threads", () => ({
  getThread: () => state.thread,
  getRecentMessagesWindow: () => state.rows,
  commitThreadWarmContext: (_threadId: string, input: { hotSince: string; summary: string }) => {
    state.commits.push({ hotSince: input.hotSince, summary: input.summary });
    state.thread = {
      ...state.thread,
      hot_since: input.hotSince,
      warm_summary: input.summary,
      warm_summary_before: input.hotSince,
    };
    return state.thread;
  },
}));
vi.mock("@/lib/stores/agent-configs", () => ({
  getAgentConfig: () => ({ id: "agent-1", model_config_name: "model-1" }),
  getAgentTierProportions: () => null,
}));
vi.mock("@/lib/stores/model-config", () => ({
  getDefaultModelConfig: () => ({ name: "model-1" }),
  getModelConfig: () => ({ provider: "mock", model_id: "mock-1" }),
  getModelParams: () => ({}),
}));
vi.mock("@/lib/providers", () => ({ getProvider: () => ({}) }));
vi.mock("@/lib/stores/memory", () => ({ putMemory: () => {} }));
vi.mock("@/lib/agents/prepare/history-window", () => ({
  unwrapWarmSummary: (s: string) => ({ scope: "foreground", content: s }),
  wrapWarmSummary: (s: string) => s,
}));
vi.mock("@/lib/agents/conversation-summary", () => ({
  summarizeTranscript: async () => "",
  transcriptText: (c: unknown) => String(c),
  extractTopicSegments: (raw: string) => ({ body: raw, topics: [] }),
}));

import { kickBoundaryCompaction, compactThreadWarmContext, pendingCompactionBoundary } from "./warm-summary-background";

describe("compactThreadWarmContext — seq-exact boundary (ADR-0088)", () => {
  it("excludes only rows at-or-after the boundary seq from the warm summary, even when their created_at ties the boundary (a same-millisecond tie is now possible since addMessage no longer bumps colliding timestamps)", async () => {
    // Two rows share one created_at. The boundary row is seq=11 (kept, not
    // summarized); seq=10 is the one thread-compaction.ts's pruneThreadMessages
    // will delete (rowid < 11). Before the fix, buildSummaryBefore filtered on
    // `created_at < boundary` alone — "T" < "T" is false for BOTH rows, so
    // seq=10 would be pruned without ever being folded into the summary.
    state.thread = {
      thread_id: "thread-1",
      hot_since: null,
      warm_summary: null,
      warm_summary_before: null,
      message_count: 2,
    };
    state.commits = [];
    state.rows = [
      { seq: 10, role: "user", content: "first turn, about to be pruned", created_at: "2026-09-25T10:00:00.000Z" },
      { seq: 11, role: "assistant", content: "boundary turn, stays in hot window", created_at: "2026-09-25T10:00:00.000Z" },
    ] as never;

    const context = await compactThreadWarmContext("thread-1", "2026-09-25T10:00:00.000Z", {
      requestedBoundarySeq: 11,
      allowEmptySummary: true,
    });

    expect(context).not.toBeNull();
    // Only seq=10 is below the boundary seq — it's the one row that gets
    // folded into the summary's source count. seq=11 (the boundary row
    // itself) must NOT be counted as summarized, since it survives the prune.
    expect(context?.sourceMessages).toBe(1);
  });
});

describe("kickBoundaryCompaction", () => {
  it("commits a boundary pinned at the very first message even though there is nothing earlier to summarize", async () => {
    state.thread = {
      thread_id: "thread-1",
      hot_since: null,
      warm_summary: null,
      warm_summary_before: null,
      message_count: 2,
    };
    state.commits = [];
    state.rows = DEFAULT_ROWS;

    kickBoundaryCompaction("thread-1", "2026-09-25T10:00:00.000Z");
    await vi.waitFor(() => expect(state.commits).toHaveLength(1));

    expect(state.commits[0]).toEqual({ hotSince: "2026-09-25T10:00:00.000Z", summary: "" });
    expect(state.thread.hot_since).toBe("2026-09-25T10:00:00.000Z");
  });

  // A second boundary request arriving while the first is still in flight
  // used to be silently dropped (the activeRefreshes/pendingBoundaries guard
  // just returned early) — the thread would settle on whichever boundary
  // was requested FIRST, not last, with no error and no indication the
  // second request was ignored. This is the real shape a user hits by
  // dragging the divider twice quickly, or two devices moving the same
  // thread's boundary — both legitimate, supported interactions.
  it("queues a boundary request that arrives while one is already in flight, converging on the LAST one requested", async () => {
    state.thread = {
      thread_id: "thread-1",
      hot_since: null,
      warm_summary: null,
      warm_summary_before: null,
      message_count: 2,
    };
    state.commits = [];
    state.rows = DEFAULT_ROWS;

    kickBoundaryCompaction("thread-1", "2026-09-25T10:00:00.000Z");
    // Second request arrives synchronously, before the first's queued
    // microtask has had a chance to run — this is the exact race.
    kickBoundaryCompaction("thread-1", "2026-09-25T11:00:00.000Z");

    // The queued (most-recently-requested) boundary is reported, not the
    // stale one already in flight — the caller asked to move to 11:00, so
    // that's what should be reported as pending, not 10:00.
    expect(pendingCompactionBoundary("thread-1")).toBe("2026-09-25T11:00:00.000Z");

    await vi.waitFor(() => expect(state.commits).toHaveLength(2));

    expect(state.commits.map((c) => c.hotSince)).toEqual([
      "2026-09-25T10:00:00.000Z",
      "2026-09-25T11:00:00.000Z",
    ]);
    expect(state.thread.hot_since).toBe("2026-09-25T11:00:00.000Z");
    expect(pendingCompactionBoundary("thread-1")).toBeNull();
  });

  it("does not re-run when the queued boundary matches what the in-flight commit already settled on", async () => {
    state.thread = {
      thread_id: "thread-1",
      hot_since: null,
      warm_summary: null,
      warm_summary_before: null,
      message_count: 2,
    };
    state.commits = [];
    state.rows = DEFAULT_ROWS;

    kickBoundaryCompaction("thread-1", "2026-09-25T10:00:00.000Z");
    kickBoundaryCompaction("thread-1", "2026-09-25T10:00:00.000Z");

    await vi.waitFor(() => expect(state.commits).toHaveLength(1));
    // Give any (incorrect) re-run a chance to fire before asserting it didn't.
    await new Promise((r) => setTimeout(r, 10));

    expect(state.commits).toHaveLength(1);
    expect(pendingCompactionBoundary("thread-1")).toBeNull();
  });
});
