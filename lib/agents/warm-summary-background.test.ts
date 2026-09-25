import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  thread: {
    thread_id: "thread-1",
    hot_since: null as string | null,
    warm_summary: null as string | null,
    warm_summary_before: null as string | null,
    message_count: 2,
  },
  commits: [] as Array<{ hotSince: string; summary: string }>,
}));

vi.mock("@/lib/stores/threads", () => ({
  getThread: () => state.thread,
  getRecentMessagesWindow: () => [
    { role: "user", content: "hello", created_at: "2026-09-25T10:00:00.000Z" },
    { role: "assistant", content: "hi", created_at: "2026-09-25T10:00:01.000Z" },
  ],
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

import { kickBoundaryCompaction } from "./warm-summary-background";

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

    kickBoundaryCompaction("thread-1", "2026-09-25T10:00:00.000Z");
    await vi.waitFor(() => expect(state.commits).toHaveLength(1));

    expect(state.commits[0]).toEqual({ hotSince: "2026-09-25T10:00:00.000Z", summary: "" });
    expect(state.thread.hot_since).toBe("2026-09-25T10:00:00.000Z");
  });
});
