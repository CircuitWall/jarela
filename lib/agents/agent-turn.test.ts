import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueThreadRunMock = vi.fn();
const prepareThreadRunMock = vi.fn();
const collectStreamMock = vi.fn();
const persistAssistantMessageMock = vi.fn();
const snapshotThreadModelConfigNameMock = vi.fn();

vi.mock("@/lib/agents/run-queue", () => ({
  enqueueThreadRun: (...args: unknown[]) => enqueueThreadRunMock(...args),
}));

vi.mock("@/lib/agents/run-thread", () => ({
  prepareThreadRun: (...args: unknown[]) => prepareThreadRunMock(...args),
  persistAssistantMessage: (...args: unknown[]) => persistAssistantMessageMock(...args),
  snapshotThreadModelConfigName: (...args: unknown[]) => snapshotThreadModelConfigNameMock(...args),
}));

vi.mock("@/lib/agents/stream-collector", () => ({
  collectStream: (...args: unknown[]) => collectStreamMock(...args),
}));

const { runAgentTurn } = await import("./agent-turn");

describe("runAgentTurn", () => {
  beforeEach(() => {
    enqueueThreadRunMock.mockReset();
    prepareThreadRunMock.mockReset();
    collectStreamMock.mockReset();
    persistAssistantMessageMock.mockReset();
    snapshotThreadModelConfigNameMock.mockReset();

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

    expect(prepareThreadRunMock).toHaveBeenCalledWith({
      thread_id: "t-1",
      message: "Ping",
      attachments: undefined,
      user_category: "scheduled_task",
      context_profile: {
        include_hot: false,
        include_warm: false,
        include_facts: false,
        include_recall: false,
      },
      _pinned_model_config_name: "Gemini Chat",
      _skip_persist_message: undefined,
    });
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
});
