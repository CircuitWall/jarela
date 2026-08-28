import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamChunk } from "@/lib/agents/base";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-auto-boundary-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.env.JARELA_MAX_THREAD_MESSAGES = "4";

const streamWithConfigMock = vi.fn();

vi.mock("@/lib/agents/llm", () => ({
  streamWithConfig: (...args: unknown[]) => streamWithConfigMock(...args),
}));

vi.mock("@/lib/scheduler", () => ({
  startScheduler: () => {},
}));

vi.mock("@/lib/providers", () => ({
  getProvider: () => ({
    chat: async () => ({
      stream: (async function* () { yield "AUTO-COMPACT-RECAP"; })(),
    }),
  }),
}));

vi.mock("@/lib/embeddings", () => ({
  embedOne: async () => null,
  cosine: () => 0,
  recall: async () => [],
}));

const { prepareThreadRun } = await import("./run-thread");
const { upsertModelConfig } = await import("@/lib/stores/model-config");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { addMessage, createThread, getMessages, getThread } = await import("@/lib/stores/threads");
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

  it("auto-moves hot_since when idle >= 3h and subject shifts", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-boundary-shift",
      name: "Boundary Shift Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
    });
    const thread = createThread("agent-boundary-shift");
    addMessage(thread.thread_id, "user", "Let's debug the OAuth callback mismatch error.");
    addMessage(thread.thread_id, "assistant", "Check your redirect URI and PKCE verifier.");
    ageThreadMessages(thread.thread_id, 4);

    await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Draft a Q3 hiring and marketing budget plan with milestones.",
      context_profile: {
        include_hot: true,
        include_warm: false,
        include_facts: false,
        include_recall: false,
      },
    });

    const updated = getThread(thread.thread_id);
    expect(updated?.hot_since).toBeTruthy();
    await waitForCondition(() => {
      const refreshed = getThread(thread.thread_id);
      return !!refreshed?.warm_summary?.includes("AUTO-COMPACT-RECAP")
        && refreshed.warm_summary_before === refreshed.hot_since;
    });
  });

  it("does not auto-move when idle >= 3h but subject is the same", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-boundary-same",
      name: "Boundary Same Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
    });
    const thread = createThread("agent-boundary-same");
    addMessage(thread.thread_id, "user", "OAuth callback mismatch on localhost redirect.");
    addMessage(thread.thread_id, "assistant", "Let's verify callback URL and state handling.");
    ageThreadMessages(thread.thread_id, 4);

    await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "OAuth callback mismatch still happens after URL normalization.",
      context_profile: {
        include_hot: true,
        include_warm: false,
        include_facts: false,
        include_recall: false,
      },
    });

    const updated = getThread(thread.thread_id);
    expect(updated?.hot_since ?? null).toBeNull();
  });

  it("does not auto-move when subject shifts but idle is under 3h", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-boundary-recent",
      name: "Boundary Recent Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
    });
    const thread = createThread("agent-boundary-recent");
    addMessage(thread.thread_id, "user", "OAuth callback mismatch on localhost redirect.");
    addMessage(thread.thread_id, "assistant", "Let's verify callback URL and state handling.");
    ageThreadMessages(thread.thread_id, 1);

    await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Draft a Q3 hiring and marketing budget plan with milestones.",
      context_profile: {
        include_hot: true,
        include_warm: false,
        include_facts: false,
        include_recall: false,
      },
    });

    const updated = getThread(thread.thread_id);
    expect(updated?.hot_since ?? null).toBeNull();
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
    expect(updated?.hot_since).toBeTruthy();
    expect(getMessages(thread.thread_id).map((m) => m.content)).toEqual([
      "older turn 23",
      "continue after retention guard",
    ]);
  });
});
