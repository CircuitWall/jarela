import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueThreadRunMock = vi.fn();
const prepareThreadRunMock = vi.fn();
const collectStreamMock = vi.fn();
const persistAssistantMessageMock = vi.fn();
const snapshotThreadModelConfigNameMock = vi.fn();
const startRunMock = vi.fn();
const finishRunMock = vi.fn();
const broadcastMock = vi.fn();
const getThreadMock = vi.fn();

vi.mock("@/lib/agents/run-queue", () => ({
  enqueueThreadRun: (...args: unknown[]) => enqueueThreadRunMock(...args),
}));

vi.mock("@/lib/agents/run-thread", () => ({
  prepareThreadRun: (...args: unknown[]) => prepareThreadRunMock(...args),
  persistAssistantMessage: (...args: unknown[]) => persistAssistantMessageMock(...args),
  snapshotThreadModelConfigName: (...args: unknown[]) => snapshotThreadModelConfigNameMock(...args),
  withInterruptMarker: (partial: string) => {
    const t = partial.trim();
    return t ? `${t}\n\n*⏸ Interrupted by user.*` : "*⏸ Interrupted by user.*";
  },
}));

vi.mock("@/lib/agents/stream-collector", () => ({
  collectStream: (...args: unknown[]) => collectStreamMock(...args),
}));

vi.mock("@/lib/agents/run-registry", () => ({
  startRun: (...args: unknown[]) => startRunMock(...args),
  finishRun: (...args: unknown[]) => finishRunMock(...args),
  broadcast: (...args: unknown[]) => broadcastMock(...args),
}));

vi.mock("@/lib/stores/threads", () => ({
  getThread: (...args: unknown[]) => getThreadMock(...args),
}));

const { runAgentTurn } = await import("./agent-turn");

describe("runAgentTurn", () => {
  beforeEach(() => {
    enqueueThreadRunMock.mockReset();
    prepareThreadRunMock.mockReset();
    collectStreamMock.mockReset();
    persistAssistantMessageMock.mockReset();
    snapshotThreadModelConfigNameMock.mockReset();
    startRunMock.mockReset();
    finishRunMock.mockReset();
    broadcastMock.mockReset();
    getThreadMock.mockReset();

    enqueueThreadRunMock.mockImplementation((thread_id: string, _source: string, runner: () => Promise<unknown>) => ({
      position: 0,
      result: runner(),
      thread_id,
    }));

    prepareThreadRunMock.mockResolvedValue({
      stream: {},
      context_snapshot: null,
      source_manifest: null,
    });
    snapshotThreadModelConfigNameMock.mockReturnValue("Gemini Chat");
    startRunMock.mockImplementation((thread_id: string, agent_id: string | null) => ({
      thread_id,
      agent_id,
      abort: new AbortController(),
    }));
    getThreadMock.mockReturnValue({ thread_id: "t-1", agent_id: "agent-x" });
  });

  it("queues, prepares, collects, and persists by default", async () => {
    collectStreamMock.mockResolvedValue({
      assistantContent: "Hello from the assistant",
      usedTools: ["tool_a"],
      toolEvents: [],
      usage: null,
    });

    const out = await runAgentTurn({
      thread_id: "t-1",
      queue_source: "trigger",
      message: "Ping",
      user_category: "scheduled_task",
      assistant_category: "scheduled_task",
    });

    expect(prepareThreadRunMock).toHaveBeenCalledWith(expect.objectContaining({
      thread_id: "t-1",
      message: "Ping",
      attachments: undefined,
      user_category: "scheduled_task",
      context_profile: {
        include_hot: false,
        include_warm: false,
        include_facts: false,
        include_recall: false,
        history_scope: "none",
      },
      _pinned_model_config_name: "Gemini Chat",
      _skip_persist_message: undefined,
    }));
    const prepareArg = prepareThreadRunMock.mock.calls[0][0] as { signal?: AbortSignal };
    expect(prepareArg.signal).toBeInstanceOf(AbortSignal);
    expect(startRunMock).toHaveBeenCalledWith("t-1", "agent-x");
    expect(finishRunMock).toHaveBeenCalledTimes(1);
    expect(persistAssistantMessageMock).toHaveBeenCalledTimes(1);
    expect(out.skippedAssistant).toBe(false);
    expect(out.preview).toContain("Hello from the assistant");
  });

  it("suppresses NO_REPLY persistence in silent mode", async () => {
    collectStreamMock.mockResolvedValue({
      assistantContent: "NO_REPLY",
      usedTools: [],
      toolEvents: [],
      usage: null,
    });

    const out = await runAgentTurn({
      thread_id: "t-2",
      queue_source: "bridge",
      message: "Observe",
      user_category: "bridge",
      assistant_category: "bridge",
      silent: true,
    });

    expect(persistAssistantMessageMock).not.toHaveBeenCalled();
    expect(out.skippedAssistant).toBe(true);
    expect(out.preview).toBe("");
  });

  it("suppresses NO_REPLY persistence when the model adds preamble prose", async () => {
    // Regression: the silent-mode prompts explicitly allow the model to
    // explain itself before the sentinel ("if nothing material, reply with
    // exactly the single token NO_REPLY") — the compliant path most models
    // actually take. An anchored-at-start regex previously missed this and
    // leaked the preamble + literal "NO_REPLY" token as a visible reply.
    collectStreamMock.mockResolvedValue({
      assistantContent: "Nothing material to report. NO_REPLY",
      usedTools: [],
      toolEvents: [],
      usage: null,
    });

    const out = await runAgentTurn({
      thread_id: "t-preamble",
      queue_source: "trigger",
      message: "Check status",
      user_category: "scheduled_task",
      assistant_category: "scheduled_task",
      silent: true,
    });

    expect(persistAssistantMessageMock).not.toHaveBeenCalled();
    expect(out.skippedAssistant).toBe(true);
    expect(out.preview).toBe("");
  });

  it("does not suppress ordinary material replies that happen to contain the words 'no reply'", async () => {
    collectStreamMock.mockResolvedValue({
      assistantContent: "The invoice total is $1,200 — no reply required from you.",
      usedTools: [],
      toolEvents: [],
      usage: null,
    });

    const out = await runAgentTurn({
      thread_id: "t-material",
      queue_source: "trigger",
      message: "Check status",
      user_category: "scheduled_task",
      assistant_category: "scheduled_task",
      silent: true,
    });

    expect(persistAssistantMessageMock).toHaveBeenCalledTimes(1);
    expect(out.skippedAssistant).toBe(false);
    expect(out.preview).toContain("no reply required");
  });

  it("suppresses empty assistant content in silent mode", async () => {
    collectStreamMock.mockResolvedValue({
      assistantContent: "   ",
      usedTools: [],
      toolEvents: [],
      usage: null,
    });

    const out = await runAgentTurn({
      thread_id: "t-3",
      queue_source: "bridge",
      message: "Observe",
      user_category: "bridge",
      assistant_category: "bridge",
      silent: true,
    });

    expect(persistAssistantMessageMock).not.toHaveBeenCalled();
    expect(out.skippedAssistant).toBe(true);
    expect(out.assistantContent.trim()).toBe("");
  });

  it("forwards background queue policy and can omit a synthetic prompt row", async () => {
    collectStreamMock.mockResolvedValue({
      assistantContent: "NO_REPLY",
      usedTools: [],
      toolEvents: [],
      usage: null,
    });

    await runAgentTurn({
      thread_id: "t-policy",
      queue_source: "trigger",
      message: "Run check",
      silent: true,
      queue_lane: "background",
      queue_expires_at: 12_345,
      persist_user_message: false,
    });

    expect(enqueueThreadRunMock).toHaveBeenCalledWith(
      "t-policy",
      "trigger",
      expect.any(Function),
      { lane: "background", expiresAt: 12_345 },
    );
    expect(prepareThreadRunMock).toHaveBeenCalledWith(expect.objectContaining({
      _skip_persist_message: true,
    }));
  });

  it("persists partial content with interrupt marker on user abort", async () => {
    collectStreamMock.mockResolvedValue({
      assistantContent: "I started writing but",
      usedTools: [],
      toolEvents: [],
      usage: null,
      terminal: "error",
      aborted: true,
    });

    await runAgentTurn({
      thread_id: "t-4",
      queue_source: "user",
      message: "Tell me a long story",
    });

    expect(persistAssistantMessageMock).toHaveBeenCalledTimes(1);
    const persistedContent = persistAssistantMessageMock.mock.calls[0][1] as string;
    expect(persistedContent).toContain("I started writing but");
    expect(persistedContent).toContain("Interrupted by user");
  });

  it("throws generic terminal stream errors without persisting partial output", async () => {
    collectStreamMock.mockResolvedValue({
      assistantContent: "Partial reply that must not escape",
      usedTools: [],
      toolEvents: [],
      usage: null,
      terminal: "error",
      errorMessage: "Provider connection failed",
      errorCode: "provider_error",
      errorProvider: "example",
    });

    await expect(runAgentTurn({
      thread_id: "t-error",
      queue_source: "trigger",
      message: "Run check",
    })).rejects.toMatchObject({
      name: "AgentTurnStreamError",
      message: "Provider connection failed",
      code: "provider_error",
      provider: "example",
    });

    expect(persistAssistantMessageMock).not.toHaveBeenCalled();
    expect(finishRunMock).toHaveBeenCalledWith(expect.anything(), "error");
  });

  it("persists bare interrupt marker when aborted before any tokens", async () => {
    collectStreamMock.mockResolvedValue({
      assistantContent: "",
      usedTools: [],
      toolEvents: [],
      usage: null,
      terminal: "error",
      aborted: true,
    });

    await runAgentTurn({
      thread_id: "t-5",
      queue_source: "user",
      message: "Stop right away",
    });

    expect(persistAssistantMessageMock).toHaveBeenCalledTimes(1);
    const persistedContent = persistAssistantMessageMock.mock.calls[0][1] as string;
    expect(persistedContent).toContain("Interrupted by user");
  });

  it("persists interrupt marker even in silent mode so bridges record the cut", async () => {
    collectStreamMock.mockResolvedValue({
      assistantContent: "",
      usedTools: [],
      toolEvents: [],
      usage: null,
      terminal: "error",
      aborted: true,
    });

    const out = await runAgentTurn({
      thread_id: "t-6",
      queue_source: "bridge",
      message: "Observe",
      silent: true,
    });

    expect(persistAssistantMessageMock).toHaveBeenCalledTimes(1);
    expect(out.skippedAssistant).toBe(false);
  });
});
