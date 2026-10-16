import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<{ seq: number; role: "user" | "assistant"; content: string; created_at: string }>,
  movedSeq: null as number | null,
  movedTo: null as string | null,
  alignTopicBoundary: false,
  context: undefined as unknown,
  archived: [] as Array<{ summary: string; message_count: number }>,
}));

vi.mock("@/lib/stores/agent-configs", () => ({
  getAgentConfig: () => ({ id: "agent-1", name: "Test agent", model_config_name: "model-1" }),
}));
vi.mock("@/lib/stores/threads", () => ({
  getOrCreateAgentThread: () => ({ thread_id: "thread-1", warm_summary: null, warm_summary_before: null }),
  getMessages: () => state.rows,
  getThread: () => ({ hot_since: state.movedTo, warm_summary: "summary", warm_summary_before: state.movedTo }),
  pruneThreadMessages: () => 0,
}));
vi.mock("@/lib/stores/memory", () => ({
  putMemory: (_ns: string, _key: string, value: { summary: string; message_count: number }) => { state.archived.push(value); },
  listMemory: () => [],
  deleteMemory: () => false,
}));
vi.mock("@/lib/agents/warm-summary-background", () => ({
  trackManualCompaction: async <T,>(_threadId: string, _seq: number, run: () => Promise<T>) => run(),
  compactThreadWarmContext: async (_threadId: string, boundarySeq: number, options: { alignTopicBoundary: boolean }) => {
    state.movedSeq = boundarySeq;
    state.movedTo = state.rows.at(-1)?.created_at ?? null;
    state.alignTopicBoundary = options.alignTopicBoundary;
    if (state.context !== undefined) return state.context;
    return { boundary: state.movedTo, boundarySeq, summary: "summary", sourceMessages: state.rows.length, sourceChars: 42, topics: [], channels: [] };
  },
}));
vi.mock("@/lib/env/config", () => ({ getConfig: () => ({ maxThreadMessages: 1000, maxSessionArchives: 20 }) }));

import { autoCompactionKeepLast, compactAgentThread } from "./thread-compaction";

describe("autoCompactionKeepLast", () => {
  it("leaves headroom below the configured retention cap", () => {
    expect(autoCompactionKeepLast(1000)).toBe(900);
    expect(autoCompactionKeepLast(50)).toBe(30);
  });

  it("keeps at least one message for tiny caps", () => {
    expect(autoCompactionKeepLast(1)).toBe(1);
    expect(autoCompactionKeepLast(10)).toBe(1);
  });

  it("places a full-session reset boundary after the final message", async () => {
    state.movedTo = null;
    state.movedSeq = null;
    state.rows = [{
      seq: 1,
      role: "user",
      content: "start a fresh session",
      created_at: "2026-09-25T12:00:00.000Z",
    }];

    const result = await compactAgentThread("agent-1");

    expect(result.compacted).toBe(true);
    expect(result.hot_since).toBe("2026-09-25T12:00:00.000Z");
    expect(state.movedTo).toBe("2026-09-25T12:00:00.000Z");
    expect(state.movedSeq).toBe(2);
    expect(state.alignTopicBoundary).toBe(false);
  });

  it("resets all context even when ordinary retention would keep recent rows", async () => {
    state.movedTo = null;
    state.movedSeq = null;
    state.rows = [
      { seq: 1, role: "user", content: "older session", created_at: "2026-09-25T12:00:00.000Z" },
      { seq: 2, role: "assistant", content: "older answer", created_at: "2026-09-25T12:00:01.000Z" },
      { seq: 3, role: "user", content: "start fresh", created_at: "2026-09-25T12:00:02.000Z" },
    ];

    const result = await compactAgentThread("agent-1", 1, true);

    expect(result.compacted).toBe(true);
    expect(result.hot_since).toBe("2026-09-25T12:00:02.000Z");
    expect(state.movedTo).toBe("2026-09-25T12:00:02.000Z");
    expect(state.movedSeq).toBe(4);
    expect(state.alignTopicBoundary).toBe(false);
  });

  it("archives channel recaps and counts their messages when the thread only has bridge activity", async () => {
    state.archived = [];
    state.rows = [
      { seq: 1, role: "user", content: "bridge in", created_at: "2026-09-25T12:00:00.000Z" },
      { seq: 2, role: "assistant", content: "bridge out", created_at: "2026-09-25T12:00:01.000Z" },
    ];
    state.context = {
      boundary: "2026-09-25T12:00:01.000Z",
      boundarySeq: 3,
      summary: "",
      sourceMessages: 0,
      sourceChars: 0,
      topics: [],
      channels: [
        { channel: "scheduled_task", summary: "", sourceMessages: 0 },
        { channel: "bridge", summary: "--- bridge activity summary ---\nbooked a table", sourceMessages: 2 },
      ],
    };

    const result = await compactAgentThread("agent-1", 1000, true);
    state.context = undefined;

    expect(result.compacted).toBe(true);
    if (result.compacted) expect(result.message_count).toBe(2);
    expect(state.archived.at(-1)?.summary).toBe("--- bridge activity summary ---\nbooked a table");
    expect(state.archived.at(-1)?.message_count).toBe(2);
  });

  it("reports a distinct reason when messages exist but no summary was produced", async () => {
    state.rows = [{ seq: 1, role: "user", content: "hi", created_at: "2026-09-25T12:00:00.000Z" }];
    state.context = null;

    const result = await compactAgentThread("agent-1", 1000, true);
    state.context = undefined;

    expect(result).toEqual({ compacted: false, reason: "no summary produced" });
  });

  it("reports nothing to compact for an empty thread", async () => {
    state.rows = [];
    expect(await compactAgentThread("agent-1")).toEqual({ compacted: false, reason: "nothing to compact" });
  });
});