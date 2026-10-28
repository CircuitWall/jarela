import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamChunk, StreamOptions } from "@/lib/agents/base";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-auto-boundary-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.env.JARELA_MAX_THREAD_MESSAGES = "4";

const streamWithConfigMock = vi.fn();
let providerSummary = "AUTO-COMPACT-RECAP";
let providerCalls = 0;

vi.mock("@/lib/agents/llm", () => ({
  streamWithConfig: (...args: unknown[]) => streamWithConfigMock(...args),
}));

vi.mock("@/lib/scheduler", () => ({
  startScheduler: () => {},
}));

vi.mock("@/lib/providers", () => ({
  getProvider: () => ({
    chat: async () => (providerCalls++, {
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

  it.each([
    { name: "short balanced turn", model: "gpt-4o-mini", strategy: "balanced", chars: 100, max: undefined, expected: 4_096 },
    { name: "long balanced turn", model: "gpt-4o-mini", strategy: "balanced", chars: 6_000, max: undefined, expected: 6_000 },
    { name: "explicit ceiling", model: "gpt-4o-mini", strategy: "balanced", chars: 6_000, max: 1_024, expected: 1_024 },
    { name: "ceiling is not a baseline", model: "gpt-4o-mini", strategy: "balanced", chars: 100, max: 8_192, expected: 4_096 },
    { name: "known model ceiling", model: "gpt-4o-mini", strategy: "balanced", chars: 20_000, max: undefined, expected: 16_384 },
    { name: "balanced reasoning floor", model: "gpt-5", strategy: "balanced", chars: 100, max: undefined, expected: 32_768 },
    { name: "high reasoning floor", model: "gpt-5", strategy: "high_reasoning", chars: 100, max: undefined, expected: 32_768 },
    { name: "cost-saving baseline", model: "gpt-4o-mini", strategy: "cost_saving", chars: 100, max: undefined, expected: 2_048 },
  ] as const)("reserves and forwards an adaptive budget for $name", async ({ model, strategy, chars, max, expected }) => {
    const configName = `adaptive-${model}-${strategy}-${chars}-${max ?? "auto"}`;
    upsertModelConfig(configName, "openai", model, max === undefined ? {} : { max_tokens: max }, false);
    upsertAgentConfig({
      id: "adaptive-budget",
      name: "Adaptive budget",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: configName,
      usage_strategy: strategy,
    });
    const thread = createThread("adaptive-budget");

    await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "x".repeat(chars),
      context_profile: { include_warm: false, include_facts: false, include_recall: false },
    });

    const options = streamWithConfigMock.mock.calls[0][2] as StreamOptions;
    expect(options.agent_run_config?.max_output_tokens).toBe(expected);
    expect(options.agent_run_config?.output_reserve_tokens).toBe(expected);
  });

  it("bounds and reserves the output budget within an explicitly smaller context window", async () => {
    upsertModelConfig("adaptive-small-context", "openai", "gpt-4o-mini", { context_window_tokens: 2_048 }, false);
    upsertAgentConfig({
      id: "adaptive-small-context",
      name: "Small context",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: "adaptive-small-context",
      usage_strategy: "balanced",
    });
    const thread = createThread("adaptive-small-context");
    await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "x".repeat(100),
      context_profile: { include_warm: false, include_facts: false, include_recall: false },
    });

    const options = streamWithConfigMock.mock.calls[0][2] as StreamOptions;
    expect(options.agent_run_config?.max_output_tokens).toBe(823);
    expect(options.agent_run_config?.output_reserve_tokens).toBe(823);
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
      message_metadata: { hidden_from_chat: true },
      context_profile: { include_hot: true, include_warm: false, include_facts: false, include_recall: false },
      _onTranscriptUserPersisted: () => {
        const rows = getMessages(thread.thread_id);
        hookSawUserRow = rows.at(-1)?.role === "user";
        addMessage(thread.thread_id, "assistant", "", null, null, null, "in_progress");
      },
    });

    expect(getMessages(thread.thread_id).find((row) => row.msg_id === persisted.userMessageId)?.transcript_status)
      .toBe("in_progress");
    expect(JSON.parse(getMessages(thread.thread_id).find((row) => row.msg_id === persisted.userMessageId)?.metadata ?? "{}"))
      .toMatchObject({ hidden_from_chat: true });
    updateMessageContent(persisted.userMessageId, persisted.storedContent, { transcriptStatus: "completed" });

    await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Persist this before the assistant draft.",
      _user_message_persisted: true,
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

  async function seedBridgeHeavyAgent(agentId: string, foregroundTurns: number) {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: agentId,
      name: agentId,
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
    });
    const thread = createThread(agentId);
    const metadata = { bridge_conversation: { key: "wa:chat-1" } };
    for (let i = 0; i < 20; i++) {
      addMessage(thread.thread_id, i % 2 === 0 ? "user" : "assistant", `bridge turn ${i}`, undefined, "bridge", metadata);
    }
    for (let i = 0; i < foregroundTurns; i++) {
      addMessage(thread.thread_id, "user", `chat question ${i}`);
      addMessage(thread.thread_id, "assistant", `chat answer ${i}`);
    }
    return { thread, metadata };
  }

  it("does not start size compaction for bridge rows that compaction can never prune", async () => {
    const { thread, metadata } = await seedBridgeHeavyAgent("agent-bridge-only", 0);
    const onCompacting = vi.fn();
    await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "new bridge message",
      user_category: "bridge",
      message_metadata: metadata,
      history_bridge_key: "wa:chat-1",
      context_profile: { history_scope: "bridge", include_hot: true, include_warm: false, include_facts: false, include_recall: false },
      _onCompacting: onCompacting,
    });
    expect(onCompacting).not.toHaveBeenCalled();
    expect(getMessages(thread.thread_id).filter((m) => m.category === "bridge")).toHaveLength(21);
  });

  it("does not report compacting on a short chat just because the bridge history is long", async () => {
    const { thread } = await seedBridgeHeavyAgent("agent-bridge-mixed", 1);
    const onCompacting = vi.fn();
    await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "quick chat question",
      context_profile: { include_hot: true, include_warm: false, include_facts: false, include_recall: false },
      _onCompacting: onCompacting,
    });
    expect(onCompacting).not.toHaveBeenCalled();
  });

  it("still size-compacts once the chat itself outgrows the cap alongside bridge rows", async () => {
    const { thread } = await seedBridgeHeavyAgent("agent-bridge-busy-chat", 6);
    const onCompacting = vi.fn();
    await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "long chat question",
      context_profile: { include_hot: true, include_warm: false, include_facts: false, include_recall: false },
      _onCompacting: onCompacting,
    });
    expect(onCompacting).toHaveBeenCalledTimes(1);
  });

  it("does not re-run hot-turn compaction on the very next turn after a commit", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-hot-turn-rolling",
      name: "Rolling Hot Turn Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
      history_window_hours: 0,
      hot_turn_limit: 2,
    });
    const thread = createThread("agent-hot-turn-rolling");
    for (let i = 0; i < 4; i += 1) {
      addMessage(thread.thread_id, "user", `topic ${i} question`);
      addMessage(thread.thread_id, "assistant", `topic ${i} answer`);
    }
    const seeded = getMessages(thread.thread_id);
    seeded.forEach((message, index) => {
      getDb().prepare("UPDATE messages SET created_at=? WHERE msg_id=?")
        .run(new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), message.msg_id);
    });
    const rows = getMessages(thread.thread_id);
    providerSummary = [
      "AUTO-COMPACT-RECAP",
      "```jarela-topics",
      JSON.stringify([{
        title: "later topic",
        start_seq: rows[4].seq,
        end_seq: rows[7].seq,
        start_at: rows[4].created_at,
        end_at: rows[7].created_at,
        recap: "Topics 2 and 3.",
        facts: [],
      }]),
      "```",
    ].join("\n");
    const turn = (message: string) => prepareThreadRun({
      thread_id: thread.thread_id,
      message,
      context_profile: { include_hot: true, include_warm: false, include_facts: false, include_recall: false },
    });

    await turn("topic 4 question");
    await waitForCondition(() => getThread(thread.thread_id)?.hot_since_seq === rows[4].seq);
    addMessage(thread.thread_id, "assistant", "topic 4 answer");
    await new Promise((resolve) => setTimeout(resolve, 50));

    providerCalls = 0;
    await turn("topic 5 question");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(providerCalls).toBe(0);
    addMessage(thread.thread_id, "assistant", "topic 5 answer");

    // The cooldown is half the turn limit; the turn after it re-evaluates.
    await turn("topic 6 question");
    await waitForCondition(() => providerCalls > 0);
    expect(getThread(thread.thread_id)?.hot_since_seq).toBe(rows[4].seq);
  });
});