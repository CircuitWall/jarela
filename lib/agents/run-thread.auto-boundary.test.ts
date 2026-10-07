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
  cosine: () => 0,
  recall: async () => [],
  upsertMemoryEmbedCache: () => {},
  evictMemoryEmbedCache: () => {},
  upsertMessageEmbedCache: () => {},
  resetMessageEmbedCache: () => {},
}));

const { prepareThreadRun } = await import("./run-thread");
const { upsertModelConfig } = await import("@/lib/stores/model-config");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { addMessage, createThread, getMessages, getThread, setThreadContextPin } = await import("@/lib/stores/threads");
const { getDb } = await import("@/lib/db");

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

  it("hints the agent to ask when the thread was idle for 3h or more", async () => {
    const prompt = await runAfterIdle("agent-gap-long", 4, "hey");
    expect(prompt).toContain("--- Conversation gap ---");
  });

  it("omits the gap hint when the thread is warm", async () => {
    const prompt = await runAfterIdle("agent-gap-short", 1, "hey");
    expect(prompt).not.toContain("--- Conversation gap ---");
  });

  it("starts topic-aware compaction when the hot-turn limit is exceeded", async () => {
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
    for (let i = 0; i < 3; i += 1) {
      addMessage(thread.thread_id, "user", `topic ${i} question`);
      addMessage(thread.thread_id, "assistant", `topic ${i} answer`);
    }
    const seeded = getMessages(thread.thread_id);
    seeded.forEach((message, index) => {
      getDb().prepare("UPDATE messages SET created_at=? WHERE msg_id=?")
        .run(new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), message.msg_id);
    });
    const orderedSeeded = getMessages(thread.thread_id);
    providerSummary = [
      "AUTO-COMPACT-RECAP",
      "```jarela-topics",
      JSON.stringify([{
        title: "active topic",
        start_at: orderedSeeded[2].created_at,
        end_at: new Date(Date.now() + 60_000).toISOString(),
        recap: "The active topic continues across the raw boundary.",
        facts: [],
      }]),
      "```",
    ].join("\n");

    await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "topic 3 question",
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
      return !!updated?.hot_since
        && updated.warm_summary_before === updated.hot_since
        && updated.warm_summary_source_messages === 2;
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
    expect(updated?.hot_since).toBe(seeded[20].created_at);
    expect(getMessages(thread.thread_id).map((m) => m.content)).toEqual([
      "older turn 20",
      "older turn 21",
      "older turn 22",
      "older turn 23",
      "continue after retention guard",
    ]);
  });
});
