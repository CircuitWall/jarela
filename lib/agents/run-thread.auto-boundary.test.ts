import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamChunk } from "@/lib/agents/base";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-auto-boundary-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.env.JARELA_MAX_THREAD_MESSAGES = "4";

const streamWithConfigMock = vi.fn();
let providerSummary = "AUTO-COMPACT-RECAP";

vi.mock("@/lib/agents/llm", () => ({
  streamWithConfig: (...args: unknown[]) => streamWithConfigMock(...args),
}));

vi.mock("@/lib/scheduler", () => ({
  startScheduler: () => {},
}));

vi.mock("@/lib/providers", () => ({
  getProvider: () => ({
    chat: async () => ({
      stream: (async function* () { yield providerSummary; })(),
    }),
  }),
}));

vi.mock("@/lib/embeddings", () => ({
  embedOne: async () => null,
  processMessageEmbeddingJobs: async () => 0,
  cosine: () => 0,
  recall: async () => [],
  upsertMemoryEmbedCache: () => {},
  evictMemoryEmbedCache: () => {},
  upsertMessageEmbedCache: () => {},
  resetMessageEmbedCache: () => {},
}));

const { isHotContextNearBudget, persistThreadRunUserMessage, prepareThreadRun } = await import("./run-thread");
const { upsertModelConfig } = await import("@/lib/stores/model-config");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { addMessage, createThread, getMessages, getThread, pruneThreadMessages, setThreadContextPin, updateMessageContent } = await import("@/lib/stores/threads");
const { getDb } = await import("@/lib/db");
const { resetConfigCache } = await import("@/lib/env/config");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function chunks(...items: StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

function ageThreadMessages(threadId: string, hoursAgo: number): void {
  const base = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
  getDb().prepare("UPDATE messages SET created_at=? WHERE thread_id=?").run(base, threadId);
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

describe("prepareThreadRun auto context boundary", () => {
  beforeEach(() => {
    process.env.JARELA_MAX_THREAD_MESSAGES = "4";
    resetConfigCache();
    providerSummary = "AUTO-COMPACT-RECAP";
    streamWithConfigMock.mockReset();
    process.env.JARELA_MODEL_ROUTER_MODE = "off";
    streamWithConfigMock.mockImplementation(() => chunks(
      {
        type: "done",
        data: {
          message_id: "done-1",
          usage: { input_tokens: 1, output_tokens: 1, source: "estimate" },
          provider: "openai",
          model_id: "gpt-4o-mini",
          model_config_name: "default",
        },
      },
    ));
  });

  it("requests compaction before the hot token budget is exhausted", () => {
    expect(isHotContextNearBudget(84, 100)).toBe(false);
    expect(isHotContextNearBudget(85, 100)).toBe(true);
    expect(isHotContextNearBudget(100, 100)).toBe(true);
    expect(isHotContextNearBudget(100, 0)).toBe(false);
  });

  async function runAfterIdle(agentId: string, hoursAgo: number, message: string): Promise<string> {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: agentId,
      name: agentId,
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
      history_window_hours: 0,
    });
    const thread = createThread(agentId);
    addMessage(thread.thread_id, "user", "Let's debug the OAuth callback mismatch error.");
    addMessage(thread.thread_id, "assistant", "Check your redirect URI and PKCE verifier.");
    ageThreadMessages(thread.thread_id, hoursAgo);

    await prepareThreadRun({
      thread_id: thread.thread_id,
      message,
      context_profile: { include_hot: true, include_warm: false, include_facts: false, include_recall: false },
    });

    // The runtime no longer moves the boundary on idle; only the prompt hint differs.
    expect(getThread(thread.thread_id)?.hot_since ?? null).toBeNull();
    const options = streamWithConfigMock.mock.calls[0][2] as { agent_run_config: { system_prompt: string } };
    return options.agent_run_config.system_prompt;
  }

  it("creates the assistant draft through the hook after the user row is durable", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-transcript-order",
      name: "Transcript Order",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
      history_window_hours: 0,
    });
    const thread = createThread("agent-transcript-order");
    for (let i = 0; i < 4; i += 1) {
      addMessage(thread.thread_id, "user", `older question ${i}`);
      addMessage(thread.thread_id, "assistant", `older answer ${i}`);
    }
    let hookSawUserRow = false;

    const persisted = await persistThreadRunUserMessage({
      thread_id: thread.thread_id,
      message: "Persist this before the assistant draft.",
      context_profile: { include_hot: true, include_warm: false, include_facts: false, include_recall: false },
      _onTranscriptUserPersisted: () => {
        const rows = getMessages(thread.thread_id);
        hookSawUserRow = rows.at(-1)?.role === "user";
        addMessage(thread.thread_id, "assistant", "", null, null, null, "in_progress");
      },
    });

    expect(getMessages(thread.thread_id).find((row) => row.msg_id === persisted.userMessageId)?.transcript_status)
      .toBe("in_progress");
    updateMessageContent(persisted.userMessageId, persisted.storedContent, { transcriptStatus: "completed" });

    await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Persist this before the assistant draft.",
      _user_message_persisted: true,
      _message_count_before_user: persisted.messageCountBefore,
      _idle_ms_before_user: persisted.idleMsBefore,
      context_profile: { include_hot: true, include_warm: false, include_facts: false, include_recall: false },
    });

    const rows = getMessages(thread.thread_id);
    expect(hookSawUserRow).toBe(true);
    expect(rows.slice(-2).map((row) => [row.role, row.transcript_status])).toEqual([
      ["user", "completed"],
      ["assistant", "in_progress"],
    ]);
    expect(rows.at(-1)!.seq).toBeGreaterThan(rows.at(-2)!.seq);
    expect(JSON.stringify(streamWithConfigMock.mock.calls.at(-1)?.[1]))
      .toContain("Persist this before the assistant draft.");
  });

  it("keeps a later queued user prompt out of the active turn's history", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-queued-context",
      name: "Queued Context",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
      history_window_hours: 0,
    });
    const thread = createThread("agent-queued-context");
    addMessage(thread.thread_id, "user", "active prompt");
    addMessage(thread.thread_id, "assistant", "", null, null, null, "in_progress");
    addMessage(thread.thread_id, "user", "later queued prompt", undefined, null, null, "in_progress");
    addMessage(thread.thread_id, "assistant", "", null, null, null, "in_progress");

    const prepared = await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "active prompt",
      _user_message_persisted: true,
      context_profile: { include_hot: true, include_warm: false, include_facts: false, include_recall: false },
    });
    const history = streamWithConfigMock.mock.calls.at(-1)?.[1];

    expect(JSON.stringify(history)).toContain("active prompt");
    expect(JSON.stringify(history)).not.toContain("later queued prompt");
  });

  it("accepts the committed reset cursor after its boundary row has been pruned", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-reset-cursor-run",
      name: "Reset Cursor Run",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
      history_window_hours: 0,
    });
    const thread = createThread("agent-reset-cursor-run");
    addMessage(thread.thread_id, "user", "old prompt");
    const last = addMessage(thread.thread_id, "assistant", "old response");
    const resetCursor = last.seq + 1;
    setThreadContextPin(thread.thread_id, last.created_at, resetCursor);
    pruneThreadMessages(thread.thread_id, 1, resetCursor);

    await expect(prepareThreadRun({
      thread_id: thread.thread_id,
      message: "new prompt after reset",
      hot_since_seq: resetCursor,
      _user_message_persisted: true,
      context_profile: { include_hot: true, include_warm: false, include_facts: false, include_recall: false },
    })).resolves.toBeDefined();
  });

  it("hints the agent to ask when the thread was idle for 3h or more", async () => {
    const prompt = await runAfterIdle("agent-gap-long", 4, "hey");
    expect(prompt).toContain("--- Conversation gap ---");
  });

  it("omits the gap hint when the thread is warm", async () => {
    const prompt = await runAfterIdle("agent-gap-short", 1, "hey");
    expect(prompt).not.toContain("--- Conversation gap ---");
  });

  it("starts topic-aware compaction when the hot-turn limit is exceeded", async () => {
    process.env.JARELA_MAX_THREAD_MESSAGES = "100";
    resetConfigCache();
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-hot-turn-limit",
      name: "Hot Turn Limit Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
      history_window_hours: 0,
      hot_turn_limit: 1,
    });
    const thread = createThread("agent-hot-turn-limit");
    for (let i = 0; i < 6; i += 1) {
      addMessage(thread.thread_id, "user", `topic ${i} question`);
      addMessage(thread.thread_id, "assistant", `topic ${i} answer`);
    }
    const seeded = getMessages(thread.thread_id);
    seeded.forEach((message, index) => {
      getDb().prepare("UPDATE messages SET created_at=? WHERE msg_id=?")
        .run(new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), message.msg_id);
    });
    const orderedSeeded = getMessages(thread.thread_id);
    const messageCountBefore = getThread(thread.thread_id)!.message_count;
    const activePrompt = addMessage(thread.thread_id, "user", "topic 3 question");
    providerSummary = [
      "AUTO-COMPACT-RECAP",
      "```jarela-topics",
      JSON.stringify([{
        title: "active topic",
        start_seq: orderedSeeded[0].seq,
        end_seq: activePrompt.seq,
        start_at: orderedSeeded[0].created_at,
        end_at: activePrompt.created_at,
        recap: "The active topic continues across the raw boundary.",
        facts: [],
      }]),
      "```",
    ].join("\n");

    await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "topic 3 question",
      _user_message_persisted: true,
      _message_count_before_user: messageCountBefore,
      _idle_ms_before_user: null,
      context_profile: {
        include_hot: true,
        include_warm: false,
        include_facts: false,
        include_recall: false,
      },
    });

    // The trigger commits asynchronously after the topic-aware recap succeeds.
    await waitForCondition(() => {
      const updated = getThread(thread.thread_id);
      return updated?.hot_since_seq === orderedSeeded[0].seq
        && updated.warm_summary_before_seq === updated.hot_since_seq
        && updated.warm_summary_source_messages === 0;
    });
  });

  it("auto-compacts only after enough rows accumulate to leave headroom", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-oversized-thread",
      name: "Oversized Thread Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
    });
    const thread = createThread("agent-oversized-thread");
    for (let i = 0; i < 24; i++) {
      addMessage(thread.thread_id, i % 2 === 0 ? "user" : "assistant", `older turn ${i}`);
    }
    // addMessage no longer guarantees distinct created_at within a fast burst
    // (ADR-0088 — row order is `seq`, not created_at). This test's topic
    // boundary is matched by created_at label (findTopicBoundary only knows
    // the LLM's timestamp strings), so give the seeded rows deterministic,
    // strictly increasing timestamps like a real paced conversation would
    // have, instead of relying on real wall-clock resolution across a tight
    // synchronous loop.
    const restamp = getDb().prepare("UPDATE messages SET created_at=? WHERE msg_id=?");
    const insertedOrder = getMessages(thread.thread_id);
    const base = Date.now() - insertedOrder.length * 1000;
    insertedOrder.forEach((row, i) => restamp.run(new Date(base + i * 1000).toISOString(), row.msg_id));
    const seeded = getMessages(thread.thread_id);
    providerSummary = [
      "AUTO-COMPACT-RECAP",
      "```jarela-topics",
      JSON.stringify([{
        title: "retained topic",
        start_seq: seeded[20].seq,
        end_seq: seeded[23].seq,
        start_at: seeded[20].created_at,
        end_at: seeded[23].created_at,
        recap: "The retained topic spans the size-compaction boundary.",
        facts: [],
      }]),
      "```",
    ].join("\n");

    await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "continue after retention guard",
      context_profile: {
        include_hot: true,
        include_warm: false,
        include_facts: false,
        include_recall: false,
      },
    });

    const updated = getThread(thread.thread_id);
    expect(updated?.warm_summary).toContain("AUTO-COMPACT-RECAP");
    expect(updated?.hot_since_seq).toBe(seeded[20].seq);
    expect(getMessages(thread.thread_id).map((m) => m.content)).toEqual([
      "older turn 20",
      "older turn 21",
      "older turn 22",
      "older turn 23",
      "continue after retention guard",
    ]);
  });
});
