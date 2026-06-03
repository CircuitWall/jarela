// Pins the bug fix where retry nudges no longer pollute the persisted
// conversation history. Before this patch, `prepareThreadRun` called
// `addMessage` unconditionally — so every stall-retry nudge ("↻ Auto-retry:
// your reply ended with a 'one moment'…") and every transient retry replay
// became a permanent user-role row the LLM mistook for real user input
// on every future turn. Real-world data showed 16 such rows on a single
// thread.
//
// We verify three contracts:
//   1. Default request (no flags) → addMessage IS called.
//   2. `_skip_persist_message: true` → addMessage NOT called, touchThread
//      NOT called.
//   3. `_inject_message_into_history: true` → streamWithConfig receives a
//      history that ends with the request's message, even though it was
//      never persisted.

import { beforeEach, describe, expect, it, vi } from "vitest";

const addMessageMock = vi.fn();
const touchThreadMock = vi.fn();
const getThreadMock = vi.fn();
const setThreadContextPinMock = vi.fn();
const getAgentConfigMock = vi.fn();
const getAgentToolsMock = vi.fn();
const getAgentTierProportionsMock = vi.fn();
const parseDelegateTargetsMock = vi.fn();
const getModelConfigMock = vi.fn();
const getDefaultModelConfigMock = vi.fn();
const getModelParamsMock = vi.fn();
const buildHistoryWindowMock = vi.fn();
const buildSystemPromptMock = vi.fn();
const resolveExperienceModeMock = vi.fn();
const streamWithConfigMock = vi.fn();
const startSchedulerMock = vi.fn();
const recallMock = vi.fn();
const recordMessageUsageMock = vi.fn();
const getPricingTablesMock = vi.fn();
const modelRatesForMock = vi.fn();
const estimateCostUsdMock = vi.fn();
const estimateTokensMock = vi.fn();
const validateWithTelemetryMock = vi.fn();

vi.mock("@/lib/stores/threads", () => ({
  addMessage: (...args: unknown[]) => addMessageMock(...args),
  touchThread: (...args: unknown[]) => touchThreadMock(...args),
  getThread: (...args: unknown[]) => getThreadMock(...args),
  setThreadContextPin: (...args: unknown[]) => setThreadContextPinMock(...args),
}));

vi.mock("@/lib/stores/tool-stats", () => ({
  recordToolUsage: () => undefined,
}));

vi.mock("@/lib/stores/agent-configs", () => ({
  getAgentConfig: (...args: unknown[]) => getAgentConfigMock(...args),
  getAgentTools: (...args: unknown[]) => getAgentToolsMock(...args),
  getAgentTierProportions: (...args: unknown[]) => getAgentTierProportionsMock(...args),
  parseDelegateTargets: (...args: unknown[]) => parseDelegateTargetsMock(...args),
}));

vi.mock("@/lib/stores/model-config", () => ({
  getDefaultModelConfig: (...args: unknown[]) => getDefaultModelConfigMock(...args),
  getModelConfig: (...args: unknown[]) => getModelConfigMock(...args),
  getModelParams: (...args: unknown[]) => getModelParamsMock(...args),
}));

vi.mock("@/lib/stores/message-usage", () => ({
  recordMessageUsage: (...args: unknown[]) => recordMessageUsageMock(...args),
}));

vi.mock("@/lib/stores/pricing", () => ({
  getPricingTables: (...args: unknown[]) => getPricingTablesMock(...args),
  modelRatesFor: (...args: unknown[]) => modelRatesForMock(...args),
  estimateCostUsd: (...args: unknown[]) => estimateCostUsdMock(...args),
}));

vi.mock("@/lib/scheduler", () => ({
  startScheduler: (...args: unknown[]) => startSchedulerMock(...args),
}));

vi.mock("@/lib/embeddings", () => ({
  recall: (...args: unknown[]) => recallMock(...args),
}));

vi.mock("@/lib/env/config", () => ({
  getConfig: () => ({ maxStallRetries: 1, maxTransientRetries: 1, maxDelegationDepth: 2 }),
}));

vi.mock("@/lib/agents/llm", () => ({
  streamWithConfig: (...args: unknown[]) => streamWithConfigMock(...args),
}));

vi.mock("@/lib/agents/prepare", () => ({
  buildHistoryWindow: (...args: unknown[]) => buildHistoryWindowMock(...args),
  buildSystemPrompt: (...args: unknown[]) => buildSystemPromptMock(...args),
  resolveExperienceMode: (...args: unknown[]) => resolveExperienceModeMock(...args),
}));

vi.mock("@/lib/agents/context-budget", () => ({
  estimateTokens: (...args: unknown[]) => estimateTokensMock(...args),
}));

vi.mock("@/lib/agents/output-validator/telemetry", () => ({
  validateWithTelemetry: (...args: unknown[]) => validateWithTelemetryMock(...args),
}));

const { prepareThreadRun } = await import("./run-thread");

function emptyStream() {
  return (async function* () {
    yield { type: "done" as const, data: { message_id: "m1" } };
  })();
}

beforeEach(() => {
  for (const m of [
    addMessageMock, touchThreadMock, getThreadMock, setThreadContextPinMock,
    getAgentConfigMock, getAgentToolsMock, getAgentTierProportionsMock,
    parseDelegateTargetsMock,
    getModelConfigMock, getDefaultModelConfigMock, getModelParamsMock,
    buildHistoryWindowMock, buildSystemPromptMock, resolveExperienceModeMock,
    streamWithConfigMock, startSchedulerMock, recallMock,
    recordMessageUsageMock, getPricingTablesMock, modelRatesForMock,
    estimateCostUsdMock, estimateTokensMock, validateWithTelemetryMock,
  ]) {
    m.mockReset();
  }

  getThreadMock.mockReturnValue({ thread_id: "t1", agent_id: "a1", task_goal: null, hot_since: null });
  getAgentConfigMock.mockReturnValue({
    id: "a1", name: "Test", history_limit: 50, history_window_hours: 8,
    model_config_name: null,
  });
  getAgentToolsMock.mockReturnValue([]);
  getAgentTierProportionsMock.mockReturnValue(null);
  parseDelegateTargetsMock.mockReturnValue([]);
  getDefaultModelConfigMock.mockReturnValue({ provider: "anthropic", model_id: "claude-opus-4-7" });
  getModelParamsMock.mockReturnValue({});
  buildHistoryWindowMock.mockResolvedValue({
    history: [
      { role: "user", content: "first turn" },
      { role: "assistant", content: "first reply" },
    ],
    budget: {
      contextWindowTokens: 200_000,
      tierBudgets: { hot: 100_000, warm: 50_000, facts: 25_000 },
    },
    warmSummaryCtx: "",
    factsCtx: "",
    tierUsage: { hot_tokens: 100, warm_tokens: 0, facts_tokens: 0, overhead_tokens: 0 },
  });
  buildSystemPromptMock.mockReturnValue("SYSTEM");
  resolveExperienceModeMock.mockReturnValue("default");
  streamWithConfigMock.mockReturnValue(emptyStream());
  recallMock.mockResolvedValue([]);
  estimateTokensMock.mockReturnValue(0);
  validateWithTelemetryMock.mockReturnValue({ ok: true });
});

describe("prepareThreadRun — message persistence", () => {
  it("persists the user message by default (regression)", async () => {
    await prepareThreadRun({ thread_id: "t1", message: "hello" });
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]).toEqual(["t1", "user", "hello", undefined, null]);
    expect(touchThreadMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT persist when _skip_persist_message is true (stall-retry path)", async () => {
    await prepareThreadRun({
      thread_id: "t1",
      message: "↻ Auto-retry: your reply ended with a one-moment promise…",
      _skip_persist_message: true,
      _inject_message_into_history: true,
    });
    expect(addMessageMock).not.toHaveBeenCalled();
    expect(touchThreadMock).not.toHaveBeenCalled();
  });

  it("does NOT persist when _skip_persist_message is true (transient-retry path, no inject)", async () => {
    await prepareThreadRun({
      thread_id: "t1",
      message: "original user turn",
      _skip_persist_message: true,
    });
    expect(addMessageMock).not.toHaveBeenCalled();
    expect(touchThreadMock).not.toHaveBeenCalled();
  });
});

describe("prepareThreadRun — in-memory history injection", () => {
  it("appends the message to history when _inject_message_into_history is true", async () => {
    await prepareThreadRun({
      thread_id: "t1",
      message: "synthetic nudge",
      _skip_persist_message: true,
      _inject_message_into_history: true,
    });
    // streamWithConfig(threadId, history, opts, signal)
    const history = streamWithConfigMock.mock.calls[0][1];
    expect(history).toHaveLength(3);
    expect(history[2]).toEqual({ role: "user", content: "synthetic nudge" });
  });

  it("does NOT append when _inject_message_into_history is false (transient retry)", async () => {
    await prepareThreadRun({
      thread_id: "t1",
      message: "original user turn",
      _skip_persist_message: true,
    });
    const history = streamWithConfigMock.mock.calls[0][1];
    // Only the two messages from buildHistoryWindow's mock — nothing
    // appended on top.
    expect(history).toHaveLength(2);
  });

  it("default request also does not append (the message was already persisted, so the DB-built history covers it)", async () => {
    await prepareThreadRun({ thread_id: "t1", message: "fresh user input" });
    const history = streamWithConfigMock.mock.calls[0][1];
    expect(history).toHaveLength(2);
  });
});
