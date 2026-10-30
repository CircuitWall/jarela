import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  createDelegationBudget,
  DEFAULT_DELEGATION_MAX_CALLS,
} from "@/lib/agents/delegation-budget";

const getAgentConfigMock = vi.fn();
const parseDelegateTargetsMock = vi.fn();
const getThreadMock = vi.fn();
const getOrCreateAgentThreadMock = vi.fn();
const prepareThreadRunMock = vi.fn();
const persistAssistantMessageMock = vi.fn();
const collectStreamMock = vi.fn();
const getAllToolCatalogMock = vi.fn();
const applyAgentPermissionsMock = vi.fn();
const allowedToolsMock = vi.fn();
const enqueueThreadRunMock = vi.fn();

let parentPermission: "enabled" | "disabled" = "enabled";
let parentRoster: string[] = ["child"];
let childName = "Child";
let automaticallyRunQueuedJobs = true;
let queuedRunners: Array<() => Promise<void>> = [];
let activeQueueRuns: Promise<void>[] = [];

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

vi.mock("@/lib/tools", () => ({
  getAllToolCatalogAsync: (...args: unknown[]) => getAllToolCatalogMock(...args),
  applyAgentPermissionsToCatalog: (...args: unknown[]) => applyAgentPermissionsMock(...args),
  allowedToolNamesFromPermissionMap: (...args: unknown[]) => allowedToolsMock(...args),
}));

vi.mock("@/lib/agents/run-queue", () => ({
  QueueExpiredError: class QueueExpiredError extends Error {},
  enqueueThreadRun: (...args: unknown[]) => enqueueThreadRunMock(...args),
}));

vi.mock("./packages/langchain-package", () => ({
  registerLangChainPackage: () => ({
    resolveAuth: () => ({ error: "stub" }),
    unregister: () => undefined,
  }),
}));

const { delegateToAgentTool } = await import("./delegate");

function makeConfig(overrides: {
  thread_id?: string;
  delegation_depth?: number;
  delegation_ancestors?: readonly string[];
  delegation_budget?: unknown;
  signal?: AbortSignal;
} = {}): RunnableConfig {
  return {
    signal: overrides.signal,
    configurable: {
      thread_id: "parent-thread",
      delegation_depth: 0,
      delegation_ancestors: [],
      delegation_budget: createDelegationBudget(),
      ...overrides,
    },
  };
}

async function invoke(
  args: {
    agent_id: string;
    task: string;
    context?: string;
    expected_output?: string;
    validation_criteria?: string;
  },
  config: RunnableConfig,
): Promise<Record<string, unknown>> {
  const raw = await delegateToAgentTool.invoke(args, config);
  return JSON.parse(raw as string) as Record<string, unknown>;
}

async function invokeHandler(
  args: {
    agent_id: string;
    task: string;
    context?: string;
    expected_output?: string;
    validation_criteria?: string;
  },
  config: RunnableConfig,
): Promise<Record<string, unknown>> {
  const raw = await delegateToAgentTool.func(args as never, undefined, config);
  return JSON.parse(raw as string) as Record<string, unknown>;
}

async function startNextQueuedRunner(): Promise<void> {
  const run = queuedRunners.shift();
  if (!run) throw new Error("No delegation callback was queued");
  await run();
}

function successfulCollection(overrides: Record<string, unknown> = {}) {
  return {
    assistantContent: "child reply",
    usedTools: ["web_search"],
    toolEvents: [],
    terminal: "done",
    usage: {
      input_tokens: 100,
      output_tokens: 25,
      provider: "openai",
      model_id: "gpt-4o-mini",
      model_config_name: "test-model",
    },
    ...overrides,
  };
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
    getAllToolCatalogMock.mockReset();
    applyAgentPermissionsMock.mockReset();
    allowedToolsMock.mockReset();
    enqueueThreadRunMock.mockReset();
    parentPermission = "enabled";
    parentRoster = ["child"];
    childName = "Child";
    automaticallyRunQueuedJobs = true;
    queuedRunners = [];
    activeQueueRuns = [];

    getThreadMock.mockReturnValue({ thread_id: "parent-thread", agent_id: "parent" });
    getAgentConfigMock.mockImplementation((id: string) => {
      if (id === "parent") return { id: "parent", name: "Parent", delegate_targets: JSON.stringify(parentRoster) };
      if (id === "child") return { id: "child", name: childName, delegate_targets: null };
      return null;
    });
    parseDelegateTargetsMock.mockImplementation((raw: string | null) => {
      try { return JSON.parse(raw ?? "[]") as string[]; } catch { return []; }
    });
    getOrCreateAgentThreadMock.mockReturnValue({ thread_id: "child-thread", agent_id: "child" });
    getAllToolCatalogMock.mockResolvedValue([{ name: "delegate_to_agent", status: "enabled" }]);
    applyAgentPermissionsMock.mockImplementation((catalog: Array<Record<string, unknown>>) =>
      catalog.map((entry) => ({ ...entry, permission: parentPermission })));
    allowedToolsMock.mockImplementation((catalog: Array<Record<string, unknown>>) =>
      catalog.filter((entry) => entry.permission === "enabled").map((entry) => entry.name));
    prepareThreadRunMock.mockResolvedValue({
      stream: {},
      thread_id: "child-thread",
      route_decision: { model_config_name: "test-model" },
      context_snapshot: { context_window_tokens: 4_096 },
    });
    collectStreamMock.mockResolvedValue(successfulCollection());
    enqueueThreadRunMock.mockImplementation((_threadId: string, _source: string, runner: () => Promise<unknown>) => {
      let resolve!: (value: unknown) => void;
      let reject!: (reason?: unknown) => void;
      const result = new Promise((res, rej) => { resolve = res; reject = rej; });
      const run = async () => {
        try { resolve(await runner()); } catch (error) { reject(error); }
      };
      queuedRunners.push(run);
      if (automaticallyRunQueuedJobs) activeQueueRuns.push(run());
      return { result, position: 0 };
    });
  });

  it("01 returns successful output with provenance and parent accountability", async () => {
    const config = makeConfig();
    const out = await invoke({ agent_id: "child", task: "Do the requested task" }, config);
    expect(out).toMatchObject({
      ok: true,
      agent_id: "child",
      agent_name: "Child",
      thread_id: "child-thread",
      depth: 1,
      result: "child reply",
      provenance: {
        delegated_by_agent_id: "parent",
        parent_thread_id: "parent-thread",
        child_agent_id: "child",
        child_thread_id: "child-thread",
        terminal: "done",
        call_number: 1,
      },
    });
    expect(out.parent_accountability).toContain("remains responsible");
    expect(persistAssistantMessageMock).toHaveBeenCalledWith(
      "child-thread", "child reply", ["web_search"], [], "delegation",
      expect.anything(), { context_window_tokens: 4_096 }, null,
      expect.anything(), null, undefined,
    );
  });

  it("02 safely supports backwards-compatible task-only handoffs with bounded defaults", async () => {
    await invoke({ agent_id: "child", task: "Summarize this issue" }, makeConfig());
    const request = prepareThreadRunMock.mock.calls[0][0] as { message: string };
    expect(request.message).toContain("Task:\nSummarize this issue");
    expect(request.message).toContain("No additional context was supplied.");
    expect(request.message).toContain("Expected output:");
    expect(request.message).toContain("Validation criteria:");
  });

  it("03 includes supplied context, expected output and validation criteria", async () => {
    await invoke({
      agent_id: "child",
      task: "Inspect the patch",
      context: "The patch changes the delegation runtime.",
      expected_output: "A concise risk summary.",
      validation_criteria: "List only reproducible findings.",
    }, makeConfig());
    const request = prepareThreadRunMock.mock.calls[0][0] as { message: string };
    expect(request.message).toContain("The patch changes the delegation runtime.");
    expect(request.message).toContain("A concise risk summary.");
    expect(request.message).toContain("List only reproducible findings.");
  });

  it("04 rechecks current roster and permission at execution start", async () => {
    await invoke({ agent_id: "child", task: "Check authority" }, makeConfig());
    expect(applyAgentPermissionsMock).toHaveBeenCalledTimes(2);
    expect(getAllToolCatalogMock).toHaveBeenCalledTimes(2);
  });

  it("05 passes the same opaque root budget into the queued child run", async () => {
    const budget = createDelegationBudget();
    await invoke({ agent_id: "child", task: "Use the shared budget" }, makeConfig({ delegation_budget: budget }));
    const request = prepareThreadRunMock.mock.calls[0][0] as {
      _delegation_budget: unknown;
      _transient_retries_left: number;
      _stall_retries_left: number;
    };
    expect(request._delegation_budget).toBe(budget);
    expect(request._transient_retries_left).toBe(0);
    expect(request._stall_retries_left).toBe(0);
  });

  it("06 serializes the child run through the thread queue", async () => {
    await invoke({ agent_id: "child", task: "Use queue" }, makeConfig());
    expect(enqueueThreadRunMock).toHaveBeenCalledWith(
      "child-thread",
      "delegate",
      expect.any(Function),
      { expiresAt: expect.any(Number) },
    );
  });

  it("07 resolves the child identity from the queued execution-time config", async () => {
    automaticallyRunQueuedJobs = false;
    const pending = invoke({ agent_id: "child", task: "Run after update" }, makeConfig());
    await vi.waitFor(() => expect(enqueueThreadRunMock).toHaveBeenCalledTimes(1));
    childName = "Updated Child";
    await startNextQueuedRunner();
    expect((await pending).agent_name).toBe("Updated Child");
  });

  it("08 uses bounded tool output and deduplicates reported tool names", async () => {
    collectStreamMock.mockResolvedValue(successfulCollection({ usedTools: ["web_search", "web_search"] }));
    const out = await invoke({ agent_id: "child", task: "Return bounded data" }, makeConfig());
    expect(out.ok).toBe(true);
    expect(out.used_tools).toEqual(["web_search"]);
    expect((out.result as string).length).toBeLessThan(16_000);
  });

  it("09 preserves an explicitly supplied parent cancellation signal", async () => {
    const controller = new AbortController();
    await invoke({ agent_id: "child", task: "Observe the signal" }, makeConfig({ signal: controller.signal }));
    const request = prepareThreadRunMock.mock.calls[0][0] as { signal: AbortSignal };
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.signal.aborted).toBe(false);
  });

  it("rejects empty or oversized handoff fields at the tool boundary", () => {
    expect(delegateToAgentTool.schema.safeParse({ agent_id: "child", task: " " }).success).toBe(false);
    expect(delegateToAgentTool.schema.safeParse({
      agent_id: "child",
      task: "Do the task",
      context: "x".repeat(6_001),
    }).success).toBe(false);
    expect(delegateToAgentTool.schema.safeParse({
      agent_id: "child",
      task: "Do the task",
      expected_output: " ",
    }).success).toBe(false);
  });

  it("refuses calls without thread context and does not resolve any delegate identity", async () => {
    const out = await invoke(
      { agent_id: "secret-target", task: "x" },
      makeConfig({ thread_id: undefined }),
    );
    expect(out).toMatchObject({ ok: false, error_code: "no_context" });
    expect(getAgentConfigMock).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied lookalike budget objects", async () => {
    const out = await invoke(
      { agent_id: "child", task: "x" },
      makeConfig({ delegation_budget: { calls: 0, cost: 0 } }),
    );
    expect(out).toMatchObject({ ok: false, error_code: "no_context" });
    expect(prepareThreadRunMock).not.toHaveBeenCalled();
  });

  it("does not disclose target or roster identities when target is not authorized", async () => {
    parentRoster = ["other-secret-id"];
    const out = await invoke({ agent_id: "secret-target", task: "x" }, makeConfig());
    expect(out).toMatchObject({ ok: false, error_code: "not_in_roster" });
    expect(JSON.stringify(out)).not.toContain("secret-target");
    expect(JSON.stringify(out)).not.toContain("other-secret-id");
    expect(prepareThreadRunMock).not.toHaveBeenCalled();
  });

  it("refuses a roster revoked after enqueue and never starts the child", async () => {
    automaticallyRunQueuedJobs = false;
    const pending = invoke({ agent_id: "child", task: "queued work" }, makeConfig());
    await vi.waitFor(() => expect(enqueueThreadRunMock).toHaveBeenCalledTimes(1));
    parentRoster = [];
    await startNextQueuedRunner();
    const out = await pending;
    expect(out).toMatchObject({ ok: false, error_code: "not_in_roster" });
    expect(prepareThreadRunMock).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain("child");
  });

  it("refuses permission revoked after enqueue", async () => {
    automaticallyRunQueuedJobs = false;
    const pending = invoke({ agent_id: "child", task: "queued work" }, makeConfig());
    await vi.waitFor(() => expect(enqueueThreadRunMock).toHaveBeenCalledTimes(1));
    parentPermission = "disabled";
    await startNextQueuedRunner();
    expect(await pending).toMatchObject({ ok: false, error_code: "permission_denied" });
    expect(prepareThreadRunMock).not.toHaveBeenCalled();
  });

  it("rejects self-delegation and ancestor cycles without running a child", async () => {
    expect(await invoke({ agent_id: "parent", task: "x" }, makeConfig()))
      .toMatchObject({ ok: false, error_code: "cycle_detected" });
    expect(await invoke(
      { agent_id: "child", task: "x" },
      makeConfig({ delegation_depth: 1, delegation_ancestors: ["child"] }),
    )).toMatchObject({ ok: false, error_code: "cycle_detected" });
    expect(prepareThreadRunMock).not.toHaveBeenCalled();
  });

  it("refuses delegation at the maximum depth", async () => {
    const out = await invoke(
      { agent_id: "child", task: "x" },
      makeConfig({ delegation_depth: 2, delegation_ancestors: ["root", "middle"] }),
    );
    expect(out).toMatchObject({ ok: false, error_code: "depth_exceeded" });
    expect(prepareThreadRunMock).not.toHaveBeenCalled();
  });

  it("enforces sequential and concurrent fan-out call limits on one root task", async () => {
    const config = makeConfig({ delegation_budget: createDelegationBudget({ maxCalls: 1 }) });
    const first = await invoke({ agent_id: "child", task: "first" }, config);
    const second = await invoke({ agent_id: "child", task: "second" }, config);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, error_code: "calls_exhausted" });

    const fanout = makeConfig({ delegation_budget: createDelegationBudget({ maxCalls: 1 }) });
    const pair = await Promise.all([
      invoke({ agent_id: "child", task: "parallel one" }, fanout),
      invoke({ agent_id: "child", task: "parallel two" }, fanout),
    ]);
    expect(pair.filter((out) => out.ok === true)).toHaveLength(1);
    expect(pair.filter((out) => out.error_code === "calls_exhausted")).toHaveLength(1);
  });

  it("refuses execution after the shared root deadline expires", async () => {
    let now = Date.now();
    const budget = createDelegationBudget({ maxDurationMs: 1, now: () => now });
    now += 1;
    const out = await invoke({ agent_id: "child", task: "late" }, makeConfig({ delegation_budget: budget }));
    expect(out).toMatchObject({ ok: false, error_code: "time_exhausted" });
    expect(enqueueThreadRunMock).not.toHaveBeenCalled();
  });

  it("aborts the child and waits for actual stream settlement on caller cancellation", async () => {
    const controller = new AbortController();
    let settleCollection!: (value: ReturnType<typeof successfulCollection>) => void;
    collectStreamMock.mockReturnValue(new Promise((resolve) => { settleCollection = resolve; }));
    const pending = invokeHandler({ agent_id: "child", task: "cancel me" }, makeConfig({ signal: controller.signal }))
      .catch((error: unknown) => error);
    while (collectStreamMock.mock.calls.length === 0) await Promise.resolve();
    controller.abort();
    await Promise.resolve();
    expect((prepareThreadRunMock.mock.calls[0][0] as { signal: AbortSignal }).signal.aborted).toBe(true);
    let completed = false;
    void activeQueueRuns[0]?.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    settleCollection(successfulCollection({ aborted: true, terminal: "error", assistantContent: "" }));
    await activeQueueRuns[0];
    expect(await pending).toBeInstanceOf(Error);
    expect(completed).toBe(true);
  });

  it("aborts on timeout and waits for actual stream settlement", async () => {
    vi.useFakeTimers();
    let settleCollection!: (value: ReturnType<typeof successfulCollection>) => void;
    let now = 0;
    collectStreamMock.mockReturnValue(new Promise((resolve) => { settleCollection = resolve; }));
    const budget = createDelegationBudget({ maxDurationMs: 50, now: () => now });
    const pending = invoke({ agent_id: "child", task: "timeout me" }, makeConfig({ delegation_budget: budget }));
    while (collectStreamMock.mock.calls.length === 0) await Promise.resolve();
    now = 50;
    await vi.advanceTimersByTimeAsync(50);
    expect((prepareThreadRunMock.mock.calls[0][0] as { signal: AbortSignal }).signal.aborted).toBe(true);
    settleCollection(successfulCollection({ aborted: true, terminal: "error", assistantContent: "" }));
    expect(await pending).toMatchObject({ ok: false, error_code: "time_exhausted" });
    vi.useRealTimers();
  });

  it("rejects empty and over-limit outputs rather than returning success", async () => {
    collectStreamMock.mockResolvedValueOnce(successfulCollection({ assistantContent: "   " }));
    expect(await invoke({ agent_id: "child", task: "empty" }, makeConfig()))
      .toMatchObject({ ok: false, error_code: "invalid_output" });
    collectStreamMock.mockResolvedValueOnce(successfulCollection({ assistantContent: "x".repeat(16_001) }));
    expect(await invoke({ agent_id: "child", task: "too long" }, makeConfig()))
      .toMatchObject({ ok: false, error_code: "invalid_output" });
    expect(persistAssistantMessageMock).not.toHaveBeenCalled();
  });

  it("treats terminal errors and aborted completions as failures", async () => {
    collectStreamMock.mockResolvedValueOnce(successfulCollection({
      terminal: "error", assistantContent: "apparently useful", errorMessage: "provider failed",
    }));
    expect(await invoke({ agent_id: "child", task: "error" }, makeConfig()))
      .toMatchObject({ ok: false, terminal: "error", retryable: false, error_code: "child_error" });
    collectStreamMock.mockResolvedValueOnce(successfulCollection({ aborted: true }));
    expect(await invoke({ agent_id: "child", task: "aborted" }, makeConfig()))
      .toMatchObject({ ok: false, error_code: "aborted" });
    expect(persistAssistantMessageMock).not.toHaveBeenCalled();
  });

  it("never retries an uncertain provider failure", async () => {
    collectStreamMock.mockResolvedValueOnce(successfulCollection({
      terminal: "error", errorMessage: "uncertain provider result",
    }));
    expect(await invoke({ agent_id: "child", task: "single shot" }, makeConfig()))
      .toMatchObject({ ok: false, error_code: "child_error" });
    expect(prepareThreadRunMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the call ceiling at its exported default", () => {
    expect(DEFAULT_DELEGATION_MAX_CALLS).toBe(8);
  });
});
