import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { StreamChunk } from "./base";

const root = join(process.cwd(), `.agent-stage-tests-${randomUUID()}`);
mkdirSync(root);
process.env.JARELA_DB_DIR = root;
process.env.JARELA_MODEL_ROUTER_MODE = "off";

const state = vi.hoisted(() => ({
  stream: vi.fn(),
  release: vi.fn(),
  renew: vi.fn(),
  claim: vi.fn((agentId: string, threadId: string) => ({
    agentId, threadId, leaseToken: "fixture-lease", signals: [],
  })),
}));
vi.mock("@/lib/agents/llm", () => ({ streamWithConfig: state.stream }));
vi.mock("@/lib/scheduler", () => ({ startScheduler: () => undefined }));
vi.mock("@/lib/stores/system-signals", () => ({
  claimSystemSignals: state.claim,
  releaseSystemSignals: state.release,
  renewSystemSignalLease: state.renew,
  commitSystemSignalTranscript: (_batch: unknown, persist: () => unknown) => persist(),
}));
vi.mock("@/lib/embeddings", () => ({
  embedOne: async () => null,
  processMessageEmbeddingJobs: async () => 0,
  cosine: () => 0,
  recall: async () => [],
  upsertMessageEmbedCache: () => undefined,
}));

const { prepareThreadRun, persistAssistantMessage } = await import("./run-thread");
const { closeDb } = await import("@/lib/db");
const { deleteModelConfig, upsertModelConfig } = await import("@/lib/stores/model-config");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { createThread, addMessage, getMessages, getThread, setThreadContextPin } = await import("@/lib/stores/threads");
const { getLatestMessageUsageForThread } = await import("@/lib/stores/message-usage");
const { resetConfigCache } = await import("@/lib/env/config");

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  resetConfigCache();
  deleteModelConfig("stages");
  upsertModelConfig("stages", "openai", "gpt-4o-mini", { max_tokens: 100 }, true);
  upsertAgentConfig({
    id: "stages", name: "Stage fixture", identity: "Helper", instructions: "Be helpful.",
    tools: [], model_config_name: "stages", usage_strategy: "balanced",
  });
  state.stream.mockImplementation(() => (async function* () {
    yield { type: "done", data: {} } satisfies StreamChunk;
  })());
});

function request(threadId: string) {
  return {
    thread_id: threadId,
    message: "Request",
    disable_quality_gates: true,
    context_profile: { include_hot: true, include_warm: false, include_facts: false, include_recall: false },
  };
}

it("preserves user persistence before boundary validation and never starts inference on an invalid boundary", async () => {
  const thread = createThread("stages");
  const persisted = vi.fn();
  await expect(prepareThreadRun({
    ...request(thread.thread_id),
    hot_since_seq: 9999,
    _onTranscriptUserPersisted: persisted,
  })).rejects.toMatchObject({ code: "invalid_boundary" });
  expect(getMessages(thread.thread_id).map((row) => row.content)).toEqual(["Request"]);
  expect(persisted).toHaveBeenCalledOnce();
  expect(state.stream).not.toHaveBeenCalled();
  expect(state.claim).not.toHaveBeenCalled();
});

it("rejects an invalid thinking ceiling before committing a requested boundary change or claiming signals", async () => {
  const thread = createThread("stages");
  const prior = addMessage(thread.thread_id, "user", "Earlier");
  setThreadContextPin(thread.thread_id, "boundary", prior.seq);
  upsertModelConfig("stages", "openai", "gpt-4o-mini", {
    max_tokens: 100, thinking: { type: "enabled", budget_tokens: 100 },
  }, true);
  await expect(prepareThreadRun({
    ...request(thread.thread_id), hot_since_seq: null,
  })).rejects.toMatchObject({ code: "invalid_thinking_budget" });
  expect(getThread(thread.thread_id)?.hot_since_seq).toBe(prior.seq);
  expect(state.stream).not.toHaveBeenCalled();
  expect(state.claim).not.toHaveBeenCalled();
});

it("releases an owned signal lease when the stream fails before successful completion", async () => {
  state.stream.mockImplementation(() => (async function* () {
    yield { type: "text_delta", data: { delta: "Partial" } } satisfies StreamChunk;
    throw new Error("provider failed");
  })());
  const prepared = await prepareThreadRun(request(createThread("stages").thread_id));
  const consume = async () => {
    for await (const chunk of prepared.stream) void chunk;
  };
  await expect(consume()).rejects.toThrow("provider failed");
  expect(state.release).toHaveBeenCalledExactlyOnceWith(prepared.signal_delivery);
});

it("releases an owned lease and closes the provider iterator when its consumer returns early", async () => {
  const closed = vi.fn();
  state.stream.mockImplementation(() => (async function* () {
    try {
      yield { type: "text_delta", data: { delta: "Partial" } } satisfies StreamChunk;
      yield { type: "done", data: {} } satisfies StreamChunk;
    } finally {
      closed();
    }
  })());
  const prepared = await prepareThreadRun(request(createThread("stages").thread_id));
  for await (const chunk of prepared.stream) {
    expect(chunk.type).toBe("text_delta");
    break;
  }
  expect(closed).toHaveBeenCalledOnce();
  expect(state.release).toHaveBeenCalledExactlyOnceWith(prepared.signal_delivery);
});

it("renews an owned lease while streaming and retains it for successful transcript settlement", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    state.stream.mockImplementation(() => (async function* () {
      yield { type: "text_delta", data: { delta: "Answer" } } satisfies StreamChunk;
      now += 10_001;
      yield { type: "done", data: {} } satisfies StreamChunk;
    })());
    const prepared = await prepareThreadRun(request(createThread("stages").thread_id));
    for await (const chunk of prepared.stream) void chunk;
    expect(state.renew).toHaveBeenCalledExactlyOnceWith(prepared.signal_delivery);
    expect(state.release).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

it("records context usage without provider usage after finalizing the assistant row", () => {
  const thread = createThread("stages");
  const snapshot = {
    context_window_tokens: 1000, hot_tokens: 10, warm_tokens: 20, facts_tokens: 30,
    overhead_tokens: 40, hot_budget_tokens: 100, warm_budget_tokens: 200, facts_budget_tokens: 300,
  };
  persistAssistantMessage(thread.thread_id, "Answer", [], [], null, null, snapshot);
  const row = getMessages(thread.thread_id).at(-1);
  const usage = getLatestMessageUsageForThread(thread.thread_id);
  expect(row?.content).toBe("Answer");
  expect(usage).toMatchObject({
    message_id: row?.msg_id, input_tokens: 0, output_tokens: 0, cost_usd: 0,
    ...snapshot,
  });
});
