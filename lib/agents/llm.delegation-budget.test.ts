import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIMessageChunk } from "@langchain/core/messages";
import {
  createDelegationBudget,
  delegationBudgetSnapshot,
} from "@/lib/agents/delegation-budget";

const state = vi.hoisted(() => ({
  modelRates: { inputPer1M: 1 as number | null, outputPer1M: 2 as number | null, inferred: false, ok: true },
  callsStarted: 0,
  usageByCall: [] as Array<{ input_tokens: number; output_tokens: number } | null>,
  beforePreModel: null as (() => void) | null,
  modelMaxRetries: undefined as number | undefined,
}));

vi.mock("@langchain/langgraph/prebuilt", () => ({
  createReactAgent: ({ preModelHook }: { preModelHook: () => unknown }) => ({
    stream: async () => ({
      async *[Symbol.asyncIterator]() {
        let index = 0;
        while (index < state.usageByCall.length) {
          state.beforePreModel?.();
          preModelHook();
          state.callsStarted += 1;
          const usage = state.usageByCall[index++];
          yield ["messages", [
            new AIMessageChunk({
              content: "response",
              ...(usage ? {
                usage_metadata: {
                  input_tokens: usage.input_tokens,
                  output_tokens: usage.output_tokens,
                },
              } : {}),
            }),
            {},
          ]];
        }
      },
    }),
  }),
}));

vi.mock("@/lib/providers", () => ({ getProvider: () => ({}) }));
vi.mock("@/lib/providers/errors", () => ({
  ProviderAuthError: class ProviderAuthError extends Error {},
  isAuthErrorMessage: () => false,
  isRetryableProviderStreamError: () => false,
}));
vi.mock("@/lib/stores/model-config", () => ({
  getModelParams: () => ({ max_tokens: 100, context_window_tokens: 1_000 }),
  resolveRunnableModelConfig: () => ({
    name: "test-model",
    provider: "openai",
    model_id: "gpt-4o-mini",
    params: { max_tokens: 100, context_window_tokens: 1_000 },
  }),
  upsertModelConfig: () => undefined,
}));
vi.mock("@/lib/tools", () => ({ getAllToolsAsync: async () => [] }));
vi.mock("@/lib/providers/jarela-chat-model", () => ({
  JarelaChatModel: class JarelaChatModel {
    constructor(options: { maxRetries?: number }) {
      state.modelMaxRetries = options.maxRetries;
    }
  },
}));
vi.mock("@/lib/stores/langgraph-store", () => ({
  SqliteMemoryStore: class SqliteMemoryStore {},
}));
vi.mock("@/lib/agents/checkpointer", () => ({
  getCheckpointer: () => ({ deleteThread: async () => undefined }),
}));
vi.mock("@/lib/agents/run-registry", () => ({ drainSteering: () => [] }));
vi.mock("@/lib/attachments/spill", () => ({
  readImageRef: () => null,
  readFileRef: () => null,
}));
vi.mock("@/lib/env/config", () => ({ getConfig: () => ({ recursionLimit: 20 }) }));
vi.mock("@/lib/redaction/context", () => ({
  withMaskRun: (callback: () => unknown) => callback(),
  getMaskRunContext: () => null,
}));
vi.mock("@/lib/redaction/stream-rehydrate", () => ({
  StreamRehydrator: class StreamRehydrator {},
}));
vi.mock("@/lib/redaction/wrap-tools", () => ({
  wrapToolsForRehydrate: (tools: unknown[]) => tools,
}));
vi.mock("@/lib/tools/security/wrap-credentials", () => ({
  wrapToolsForCredentialRouting: (tools: unknown[]) => tools,
}));
vi.mock("@/lib/utils/error", () => ({
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));
vi.mock("@/lib/providers/capabilities", () => ({ modelCapabilities: () => ({ vision: false }) }));
vi.mock("@/lib/stores/pricing", () => ({
  CACHE_CREATION_INPUT_RATE_MULTIPLIER: 1.25,
  getPricingTables: () => ({}),
  modelRatesFor: () => state.modelRates,
  estimateProviderCostUsd: (
    _provider: string,
    input: number,
    output: number,
    rates: { inputPer1M: number; outputPer1M: number },
  ) => (input * rates.inputPer1M + output * rates.outputPer1M) / 1_000_000,
}));

const { streamWithConfig } = await import("./llm");

async function collect(
  budget: ReturnType<typeof createDelegationBudget>,
): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const chunks: Array<{ type: string; data: Record<string, unknown> }> = [];
  for await (const chunk of streamWithConfig("delegate-thread", [{ role: "user", content: "task" }], {
    agent_run_config: {
      system_prompt: "system",
      allowed_tools: [],
      model_config_name: "test-model",
      max_output_tokens: 100,
      context_window_tokens: 1_000,
      delegation: { depth: 1, ancestors: ["parent"] },
      delegation_budget: budget,
    },
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("delegated provider-inference cost budget", () => {
  beforeEach(() => {
    state.modelRates = { inputPer1M: 1, outputPer1M: 2, inferred: false, ok: true };
    state.callsStarted = 0;
    state.usageByCall = [];
    state.beforePreModel = null;
    state.modelMaxRetries = undefined;
  });

  it("reserves and charges each actual model inference, refusing a later tool-loop call before provider use", async () => {
    const budget = createDelegationBudget({ maxCostUsd: 0.00146 });
    state.usageByCall = [
      { input_tokens: 10, output_tokens: 5 },
      { input_tokens: 10, output_tokens: 5 },
    ];

    const chunks = await collect(budget);

    expect(state.callsStarted).toBe(1);
    expect(chunks.some((chunk) => chunk.type === "error" && chunk.data.code === "delegation_cost_budget")).toBe(true);
    expect(delegationBudgetSnapshot(budget)).toMatchObject({
      committedCostUsd: 0.00002,
      reservedCostUsd: 0,
    });
    expect(state.modelMaxRetries).toBe(0);
    expect(delegationBudgetSnapshot(budget)?.remainingCostUsd).toBeCloseTo(0.00144);
  });

  it("charges the full reservation when a provider reports no usage before the next inference", async () => {
    const budget = createDelegationBudget({ maxCostUsd: 0.00146 });
    state.usageByCall = [null, { input_tokens: 1, output_tokens: 1 }];

    const chunks = await collect(budget);

    expect(state.callsStarted).toBe(1);
    expect(chunks.some((chunk) => chunk.type === "error" && chunk.data.code === "delegation_cost_budget")).toBe(true);
    expect(delegationBudgetSnapshot(budget)?.committedCostUsd).toBeCloseTo(0.00145);
  });

  it("refuses inference when pricing is unknown or only an inferred provider rate is available", async () => {
    state.modelRates = { inputPer1M: null, outputPer1M: null, inferred: false, ok: false };
    state.usageByCall = [{ input_tokens: 1, output_tokens: 1 }];
    const unknownPriceChunks = await collect(createDelegationBudget());
    expect(state.callsStarted).toBe(0);
    expect(unknownPriceChunks.some((chunk) => chunk.type === "error" && chunk.data.code === "delegation_cost_budget")).toBe(true);

    state.modelRates = { inputPer1M: 1, outputPer1M: 2, inferred: true, ok: true };
    state.usageByCall = [{ input_tokens: 1, output_tokens: 1 }];
    state.callsStarted = 0;
    const budget = createDelegationBudget();

    const chunks = await collect(budget);

    expect(state.callsStarted).toBe(0);
    expect(chunks.some((chunk) => chunk.type === "error" && chunk.data.code === "delegation_cost_budget")).toBe(true);
    expect(delegationBudgetSnapshot(budget)).toMatchObject({
      committedCostUsd: 0,
      reservedCostUsd: 0,
    });
  });

  it("accounts a per-inference reported cost overrun and blocks subsequent inference", async () => {
    const budget = createDelegationBudget({ maxCostUsd: 0.002 });
    state.usageByCall = [{ input_tokens: 2_000, output_tokens: 0 }, { input_tokens: 1, output_tokens: 1 }];

    const chunks = await collect(budget);

    expect(state.callsStarted).toBe(1);
    expect(chunks.some((chunk) => chunk.type === "error" && chunk.data.code === "delegation_cost_budget")).toBe(true);
    expect(delegationBudgetSnapshot(budget)).toMatchObject({
      committedCostUsd: 0.002,
      remainingCostUsd: 0,
      costLimitExceeded: true,
    });
  });

  it("shares committed inference cost across nested delegated child turns", async () => {
    const budget = createDelegationBudget({ maxCostUsd: 0.0015 });
    state.usageByCall = [{ input_tokens: 500, output_tokens: 100 }];

    const first = await collect(budget);
    expect(first.some((chunk) => chunk.type === "done")).toBe(true);

    state.callsStarted = 0;
    state.usageByCall = [{ input_tokens: 1, output_tokens: 1 }];
    const second = await collect(budget);

    expect(state.callsStarted).toBe(0);
    expect(second.some((chunk) => chunk.type === "error" && chunk.data.code === "delegation_cost_budget")).toBe(true);
    expect(delegationBudgetSnapshot(budget)?.committedCostUsd).toBeCloseTo(0.0007);
  });

  it("does not start a later provider invocation after delegated cancellation", async () => {
    const controller = new AbortController();
    const budget = createDelegationBudget();
    state.usageByCall = [
      { input_tokens: 10, output_tokens: 5 },
      { input_tokens: 10, output_tokens: 5 },
    ];
    let beforeCalls = 0;
    state.beforePreModel = () => {
      beforeCalls += 1;
      if (beforeCalls === 2) controller.abort();
    };

    const chunks: Array<{ type: string; data: Record<string, unknown> }> = [];
    for await (const chunk of streamWithConfig("delegate-thread", [{ role: "user", content: "task" }], {
      agent_run_config: {
        system_prompt: "system",
        allowed_tools: [],
        model_config_name: "test-model",
        max_output_tokens: 100,
        context_window_tokens: 1_000,
        delegation: { depth: 1, ancestors: ["parent"] },
        delegation_budget: budget,
      },
    }, controller.signal)) chunks.push(chunk);

    expect(state.callsStarted).toBe(1);
    expect(chunks.some((chunk) => chunk.type === "done" && chunk.data.aborted === true)).toBe(true);
  });

  it("does not start another delegated provider invocation after the shared deadline", async () => {
    let now = 0;
    const budget = createDelegationBudget({ maxDurationMs: 10, now: () => now });
    state.usageByCall = [
      { input_tokens: 10, output_tokens: 5 },
      { input_tokens: 10, output_tokens: 5 },
    ];
    let beforeCalls = 0;
    state.beforePreModel = () => {
      beforeCalls += 1;
      if (beforeCalls === 2) now = 10;
    };

    const chunks = await collect(budget);

    expect(state.callsStarted).toBe(1);
    expect(chunks.some((chunk) => chunk.type === "error" && chunk.data.code === "delegation_cost_budget")).toBe(true);
  });

  it("does not apply delegation budgeting to a normal parent inference", async () => {
    state.modelRates = { inputPer1M: 1, outputPer1M: 2, inferred: true, ok: true };
    state.usageByCall = [
      { input_tokens: 10, output_tokens: 5 },
      { input_tokens: 10, output_tokens: 5 },
    ];
    const budget = createDelegationBudget({ maxCostUsd: 0.000001 });
    const chunks: Array<{ type: string; data: Record<string, unknown> }> = [];
    for await (const chunk of streamWithConfig("parent-thread", [{ role: "user", content: "task" }], {
      agent_run_config: {
        system_prompt: "system",
        allowed_tools: [],
        model_config_name: "test-model",
        max_output_tokens: 100,
        context_window_tokens: 1_000,
        delegation: { depth: 0, ancestors: [] },
        delegation_budget: budget,
      },
    })) chunks.push(chunk);

    expect(state.callsStarted).toBe(2);
    expect(chunks.some((chunk) => chunk.type === "done")).toBe(true);
    expect(delegationBudgetSnapshot(budget)?.committedCostUsd).toBe(0);
    expect(state.modelMaxRetries).toBeUndefined();
  });
});
