import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnableConfig } from "@langchain/core/runnables";

const getAgentConfigMock = vi.fn();
const parseDelegateTargetsMock = vi.fn();
const getThreadMock = vi.fn();
const getOrCreateAgentThreadMock = vi.fn();
const prepareThreadRunMock = vi.fn();
const persistAssistantMessageMock = vi.fn();
const collectStreamMock = vi.fn();

vi.mock("@/lib/stores/agent-configs", () => ({
  getAgentConfig: (...args: unknown[]) => getAgentConfigMock(...args),
  parseDelegateTargets: (...args: unknown[]) => parseDelegateTargetsMock(...args),
}));

vi.mock("@/lib/stores/threads", () => ({
  getThread: (...args: unknown[]) => getThreadMock(...args),
  getOrCreateAgentThread: (...args: unknown[]) => getOrCreateAgentThreadMock(...args),
}));

vi.mock("@/lib/agents/run-thread", () => ({
  MAX_DELEGATION_DEPTH: 2,
  prepareThreadRun: (...args: unknown[]) => prepareThreadRunMock(...args),
  persistAssistantMessage: (...args: unknown[]) => persistAssistantMessageMock(...args),
}));

vi.mock("@/lib/agents/stream-collector", () => ({
  collectStream: (...args: unknown[]) => collectStreamMock(...args),
}));

vi.mock("./registry", () => ({
  registerTools: () => undefined,
}));

const { delegateToAgentTool } = await import("./delegate");

function makeConfig(overrides: Partial<{
  thread_id: string;
  delegation_depth: number;
  delegation_ancestors: readonly string[];
}> = {}): RunnableConfig {
  return {
    configurable: {
      thread_id: "parent-thread",
      delegation_depth: 0,
      delegation_ancestors: [],
      ...overrides,
    },
  };
}

async function invoke(args: { agent_id: string; task: string }, config: RunnableConfig) {
  const raw = await delegateToAgentTool.invoke(args, config);
  return JSON.parse(raw as string) as Record<string, unknown>;
}

describe("delegate_to_agent tool", () => {
  beforeEach(() => {
    getAgentConfigMock.mockReset();
    parseDelegateTargetsMock.mockReset();
    getThreadMock.mockReset();
    getOrCreateAgentThreadMock.mockReset();
    prepareThreadRunMock.mockReset();
    persistAssistantMessageMock.mockReset();
    collectStreamMock.mockReset();

    getThreadMock.mockReturnValue({ thread_id: "parent-thread", agent_id: "parent" });
    getAgentConfigMock.mockImplementation((id: string) => {
      if (id === "parent") return { id: "parent", name: "Parent", delegate_targets: "[\"child\"]" };
      if (id === "child") return { id: "child", name: "Child", delegate_targets: null };
      return null;
    });
    parseDelegateTargetsMock.mockReturnValue(["child"]);
    getOrCreateAgentThreadMock.mockReturnValue({ thread_id: "child-thread", agent_id: "child" });
    prepareThreadRunMock.mockResolvedValue({ stream: {}, thread_id: "child-thread" });
    collectStreamMock.mockResolvedValue({
      assistantContent: "child reply",
      usedTools: ["web_search"],
      toolEvents: [],
      terminal: "done",
    });
  });

  it("delegates successfully when target is in roster", async () => {
    const out = await invoke({ agent_id: "child", task: "do the thing" }, makeConfig());
    expect(out.ok).toBe(true);
    expect(out.agent_id).toBe("child");
    expect(out.agent_name).toBe("Child");
    expect(out.thread_id).toBe("child-thread");
    expect(out.depth).toBe(1);
    expect(out.result).toBe("child reply");
    expect(out.used_tools).toEqual(["web_search"]);
    expect(prepareThreadRunMock).toHaveBeenCalledTimes(1);
    expect(persistAssistantMessageMock).toHaveBeenCalledWith(
      "child-thread", "child reply", ["web_search"], [], "delegation",
    );
    // Recursion args: depth 1, ancestors = [parent]
    const call = prepareThreadRunMock.mock.calls[0];
    expect(call[6]).toBe("delegation");
    expect(call[7]).toBe(1);
    expect(call[8]).toEqual(["parent"]);
  });

  it("refuses targets not in the delegate roster", async () => {
    parseDelegateTargetsMock.mockReturnValue(["other"]);
    const out = await invoke({ agent_id: "child", task: "x" }, makeConfig());
    expect(out.ok).toBe(false);
    expect(out.error_code).toBe("not_in_roster");
    expect(prepareThreadRunMock).not.toHaveBeenCalled();
  });

  it("refuses self-delegation", async () => {
    const out = await invoke({ agent_id: "parent", task: "x" }, makeConfig());
    expect(out.ok).toBe(false);
    expect(out.error_code).toBe("cycle_detected");
    expect(prepareThreadRunMock).not.toHaveBeenCalled();
  });

  it("refuses when target is already in the ancestor chain", async () => {
    const out = await invoke(
      { agent_id: "child", task: "x" },
      makeConfig({ delegation_depth: 1, delegation_ancestors: ["child"] }),
    );
    expect(out.ok).toBe(false);
    expect(out.error_code).toBe("cycle_detected");
    expect(prepareThreadRunMock).not.toHaveBeenCalled();
  });

  it("refuses at maximum delegation depth", async () => {
    const out = await invoke(
      { agent_id: "child", task: "x" },
      makeConfig({ delegation_depth: 2, delegation_ancestors: ["g1", "g2"] }),
    );
    expect(out.ok).toBe(false);
    expect(out.error_code).toBe("depth_exceeded");
    expect(prepareThreadRunMock).not.toHaveBeenCalled();
  });

  it("surfaces child-run errors with structured payload", async () => {
    collectStreamMock.mockResolvedValue({
      assistantContent: "",
      usedTools: [],
      toolEvents: [],
      terminal: "error",
      errorMessage: "model exploded",
    });
    const out = await invoke({ agent_id: "child", task: "x" }, makeConfig());
    expect(out.ok).toBe(false);
    expect(out.error_code).toBe("child_error");
    expect(out.message).toBe("model exploded");
    expect(out.agent_id).toBe("child");
    expect(out.thread_id).toBe("child-thread");
    expect(persistAssistantMessageMock).not.toHaveBeenCalled();
  });
});
