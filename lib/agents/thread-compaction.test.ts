import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<{ role: "user" | "assistant"; content: string; created_at: string }>,
  movedTo: null as string | null,
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
vi.mock("@/lib/stores/model-config", () => ({
  getModelConfig: () => ({ provider: "test", model_id: "test-model" }),
  getDefaultModelConfig: () => null,
  getModelParams: () => ({}),
}));
vi.mock("@/lib/providers", () => ({
  getProvider: () => ({
    chat: async () => ({ stream: (async function* () { yield "summary"; })() }),
  }),
}));
vi.mock("@/lib/stores/memory", () => ({ putMemory: () => {}, listMemory: () => [], deleteMemory: () => false }));
vi.mock("@/lib/agents/context-boundary", () => ({
  moveThreadContextBoundary: (_threadId: string, hotSince: string) => { state.movedTo = hotSince; },
}));
vi.mock("@/lib/agents/warm-summary-background", () => ({ findTopicBoundary: async () => null, upliftTopicFacts: () => {} }));
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
    state.rows = [{
      role: "user",
      content: "start a fresh session",
      created_at: "2026-09-25T12:00:00.000Z",
    }];

    const result = await compactAgentThread("agent-1");

    expect(result.compacted).toBe(true);
    expect(result.hot_since).toBe("2026-09-25T12:00:00.001Z");
    expect(state.movedTo).toBe("2026-09-25T12:00:00.001Z");
  });

  it("resets all context even when ordinary retention would keep recent rows", async () => {
    state.movedTo = null;
    state.rows = [
      { role: "user", content: "older session", created_at: "2026-09-25T12:00:00.000Z" },
      { role: "assistant", content: "older answer", created_at: "2026-09-25T12:00:01.000Z" },
      { role: "user", content: "start fresh", created_at: "2026-09-25T12:00:02.000Z" },
    ];

    const result = await compactAgentThread("agent-1", 1, true);

    expect(result.compacted).toBe(true);
    expect(result.hot_since).toBe("2026-09-25T12:00:02.001Z");
    expect(state.movedTo).toBe("2026-09-25T12:00:02.001Z");
  });
});
