import { beforeEach, expect, it, vi } from "vitest";
import { AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import type { StreamChunk } from "./base";

const state = vi.hoisted(() => ({
  events: [] as Array<[string, unknown]>,
  failure: null as Error | null,
  order: [] as string[],
  upsert: vi.fn(),
}));

vi.mock("@langchain/langgraph/prebuilt", () => ({
  createReactAgent: ({ preModelHook }: { preModelHook: () => unknown }) => ({
    stream: async () => {
      state.order.push("stream");
      preModelHook();
      return (async function* () {
        yield* state.events;
        if (state.failure) throw state.failure;
      })();
    },
  }),
}));
vi.mock("@/lib/providers", () => ({ getProvider: () => ({}) }));
vi.mock("@/lib/stores/model-config", () => ({
  getModelParams: () => ({ max_tokens: 100, context_window_tokens: 16_000 }),
  resolveRunnableModelConfig: () => ({
    name: "fixture", provider: "openai", model_id: "fixture-model", is_default: 0,
  }),
  upsertModelConfig: state.upsert,
}));
vi.mock("@/lib/tools", () => ({ getAllToolsAsync: async () => [] }));
vi.mock("@/lib/providers/jarela-chat-model", () => ({
  JarelaChatModel: class JarelaChatModel {},
}));
vi.mock("@/lib/stores/langgraph-store", () => ({ SqliteMemoryStore: class SqliteMemoryStore {} }));
vi.mock("@/lib/agents/checkpointer", () => ({
  getCheckpointer: () => ({ deleteThread: async () => { state.order.push("checkpoint-reset"); } }),
}));
vi.mock("@/lib/agents/run-registry", () => ({ drainSteering: () => [] }));
vi.mock("@/lib/attachments/spill", () => ({ readImageRef: vi.fn(), readFileRef: vi.fn() }));
vi.mock("@/lib/env/config", () => ({ getConfig: () => ({ recursionLimit: 20 }) }));
vi.mock("@/lib/redaction/context", () => ({
  withMaskRun: (callback: () => unknown) => callback(),
  getMaskRunContext: () => null,
}));
vi.mock("@/lib/redaction/wrap-tools", () => ({ wrapToolsForRehydrate: (tools: unknown[]) => tools }));
vi.mock("@/lib/tools/security/wrap-credentials", () => ({
  wrapToolsForCredentialRouting: (tools: unknown[]) => tools,
}));
vi.mock("@/lib/providers/capabilities", () => ({ modelCapabilities: () => ({ vision: false }) }));
vi.mock("@/lib/stores/pricing", () => ({ CACHE_CREATION_INPUT_RATE_MULTIPLIER: 1.25 }));

const { streamWithConfig } = await import("./llm");

async function collect(): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of streamWithConfig("fixture-thread", [{ role: "user", content: "Request" }])) {
    chunks.push(chunk);
  }
  return chunks;
}

beforeEach(() => {
  state.events = [];
  state.failure = null;
  state.order = [];
  state.upsert.mockReset();
});

it("resets checkpoints before invocation and projects tool calls before results with paragraph separation", async () => {
  state.events = [
    ["messages", [new AIMessageChunk({ content: "Plan" })]],
    ["messages", [new AIMessageChunk({
      content: "", tool_call_chunks: [{ id: "call", name: "file_read", args: '{"path":"fixture"}', index: 0 }],
    })]],
    ["messages", [new ToolMessage({ content: '{"ok":true}', tool_call_id: "call", name: "file_read" })]],
    ["custom", { id: "call", name: "file_read", text: "Progress" }],
    ["messages", [new AIMessageChunk({ content: "Answer" })]],
  ];
  const chunks = await collect();
  expect(state.order).toEqual(["checkpoint-reset", "stream"]);
  expect(chunks.map((chunk) => chunk.type)).toEqual([
    "text_delta", "heartbeat", "tool_call", "tool_result", "tool_progress", "text_delta", "done",
  ]);
  expect(chunks[2].data).toEqual({ id: "call", name: "file_read", arguments: { path: "fixture" } });
  expect(chunks[3].data).toMatchObject({ result: { ok: true } });
  expect(chunks[5].data).toEqual({ delta: "\n\nAnswer" });
});

it("accounts cached and reasoning usage across steps and flushes final calls exactly once", async () => {
  state.events = [
    ["messages", [new AIMessageChunk({
      content: "", tool_calls: [{ id: "last", name: "file_read", args: {} }],
      usage_metadata: {
        input_tokens: 10, output_tokens: 2, total_tokens: 12,
        input_token_details: { cache_creation: 3, cache_read: 4 },
        output_token_details: { reasoning: 1 },
      },
    })]],
    ["updates", {}],
    ["updates", {}],
    ["messages", [new AIMessageChunk({
      content: "Done", usage_metadata: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    })]],
  ];
  const chunks = await collect();
  expect(chunks.filter((chunk) => chunk.type === "tool_call")).toHaveLength(1);
  expect(chunks.at(-1)?.data).toMatchObject({
    usage: {
      input_tokens: 30, output_tokens: 7, cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4, thinking_tokens: 1, source: "provider",
    },
  });
});

it("retains accumulated usage and emits error then done for cancellation without flushing abandoned calls", async () => {
  state.events = [["messages", [new AIMessageChunk({
    content: "Partial",
    tool_calls: [{ id: "abandoned", name: "file_read", args: {} }],
    usage_metadata: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
  })]]];
  state.failure = Object.assign(new Error("cancelled"), { name: "AbortError" });
  const chunks = await collect();
  expect(chunks.map((chunk) => chunk.type)).toEqual(["text_delta", "error", "done"]);
  expect(chunks.at(-1)?.data).toMatchObject({
    aborted: true, usage: { input_tokens: 10, output_tokens: 3, source: "provider" },
  });
});

it.each([
  ["This model's maximum context length is 8192 tokens, however you requested 9000 tokens", 7372],
  ["context window exhausted, retry later", 8000],
])("corrects a context-overflow failure before returning the original HTTP error shape: %s", async (message, ceiling) => {
  state.failure = new Error(message);
  const chunks = await collect();
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({ type: "error", data: { code: "context_length_exceeded" } });
  expect(state.upsert).toHaveBeenCalledWith(
    "fixture", "openai", "fixture-model",
    { max_tokens: 100, context_window_tokens: ceiling }, false,
  );
});
