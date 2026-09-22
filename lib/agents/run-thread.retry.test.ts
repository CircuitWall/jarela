import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamChunk } from "@/lib/agents/base";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-run-thread-retry-"));
process.env.JARELA_DB_DIR = tmpRoot;

const streamWithConfigMock = vi.fn();

vi.mock("@/lib/agents/llm", () => ({
  streamWithConfig: (...args: unknown[]) => streamWithConfigMock(...args),
}));

vi.mock("@/lib/scheduler", () => ({
  startScheduler: () => {},
}));

const { prepareThreadRun } = await import("./run-thread");
const { collectStream } = await import("./stream-collector");
const { deleteModelConfig, upsertModelConfig } = await import("@/lib/stores/model-config");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { createThread } = await import("@/lib/stores/threads");

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

describe("prepareThreadRun transient retry", () => {
  beforeEach(() => {
    streamWithConfigMock.mockReset();
    process.env.JARELA_MODEL_ROUTER_MODE = "off";
  });

  it("does not duplicate the persisted user prompt in retried model history", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-retry",
      name: "Retry Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
    });
    const thread = createThread("agent-retry");

    streamWithConfigMock
      .mockImplementationOnce((_threadId: string, _messages: unknown[], _options: unknown, _signal: unknown) => chunks(
        { type: "error", data: { code: "rate_limited", message: "429 retry after 1 second" } },
      ))
      .mockImplementationOnce((_threadId: string, _messages: unknown[], _options: unknown, _signal: unknown) => chunks(
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

    const prepared = await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Ping",
      context_profile: {
        include_hot: true,
        include_warm: false,
        include_facts: false,
        include_recall: false,
      },
    });

    const collected = await collectStream(prepared.stream);
    expect(collected.terminal).toBe("done");
    expect(streamWithConfigMock).toHaveBeenCalledTimes(2);

    const secondMessages = streamWithConfigMock.mock.calls[1][1] as Array<{ role: string; content: string | unknown[] }>;
    const pingCount = secondMessages.filter((m) => m.role === "user" && m.content === "Ping").length;
    expect(pingCount).toBe(1);
  });

  it("retries a provider-neutral pre-output stream failure", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-stream-error",
      name: "Stream Error Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
    });
    const thread = createThread("agent-stream-error");

    streamWithConfigMock
      .mockImplementationOnce(() => chunks(
        { type: "error", data: { code: "stream_error", message: "stream connection reset by peer" } },
      ))
      .mockImplementationOnce(() => chunks(
        {
          type: "done",
          data: {
            message_id: "done-stream-error",
            usage: { input_tokens: 1, output_tokens: 1, source: "estimate" },
            provider: "openai",
            model_id: "gpt-4o-mini",
            model_config_name: "default",
          },
        },
      ));

    const prepared = await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Ping",
      context_profile: {
        include_hot: true,
        include_warm: false,
        include_facts: false,
        include_recall: false,
      },
    });

    const collected = await collectStream(prepared.stream);
    expect(collected.terminal).toBe("done");
    expect(streamWithConfigMock).toHaveBeenCalledTimes(2);
  });

  it("keeps per-agent router policy as retry seed instead of reverting to global", async () => {
    process.env.JARELA_MODEL_ROUTER_MODE = "heuristic";
    process.env.JARELA_MODEL_ROUTER_POLICY = "balanced";

    upsertModelConfig("m-cheap", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertModelConfig("m-quality", "openai", "gpt-4.1", { api_key: "sk-test" }, false);
    upsertAgentConfig({
      id: "agent-retry-policy",
      name: "Retry Policy Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
      router_enabled: true,
      router_policy: "cheap",
    });
    const thread = createThread("agent-retry-policy");

    streamWithConfigMock
      .mockImplementationOnce((_threadId: string, _messages: unknown[], _options: unknown, _signal: unknown) => chunks(
        { type: "error", data: { code: "rate_limited", message: "429 retry after 1 second" } },
      ))
      .mockImplementationOnce((_threadId: string, _messages: unknown[], _options: unknown, _signal: unknown) => chunks(
        {
          type: "done",
          data: {
            message_id: "done-policy-1",
            usage: { input_tokens: 1, output_tokens: 1, source: "estimate" },
            provider: "openai",
            model_id: "gpt-4o-mini",
            model_config_name: "m-cheap",
          },
        },
      ));

    const prepared = await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Ping",
      context_profile: {
        include_hot: true,
        include_warm: false,
        include_facts: false,
        include_recall: false,
      },
    });

    const collected = await collectStream(prepared.stream);
    expect(collected.terminal).toBe("done");
    expect(streamWithConfigMock).toHaveBeenCalledTimes(2);

    const firstOpts = streamWithConfigMock.mock.calls[0][2] as {
      agent_run_config?: { route_decision?: { policy?: string } };
    };
    const secondOpts = streamWithConfigMock.mock.calls[1][2] as {
      agent_run_config?: { route_decision?: { policy?: string } };
    };

    // First run should honor the agent-level override.
    expect(firstOpts.agent_run_config?.route_decision?.policy).toBe("cheap");
    // Retry should advance from cheap -> balanced. If it reverts to the global
    // seed (balanced), it would incorrectly jump to quality.
    expect(secondOpts.agent_run_config?.route_decision?.policy).toBe("balanced");
  });

  it("adds env override and restart tools to the effective self-config surface", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-env-config",
      name: "Env Config Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
    });
    const thread = createThread("agent-env-config");

    streamWithConfigMock.mockImplementationOnce(() => chunks(
      {
        type: "done",
        data: {
          message_id: "done-env-1",
          usage: { input_tokens: 1, output_tokens: 1, source: "estimate" },
          provider: "openai",
          model_id: "gpt-4o-mini",
          model_config_name: "default",
        },
      },
    ));

    await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Lower the idle timeout and restart if needed",
      context_profile: {
        include_hot: true,
        include_warm: false,
        include_facts: false,
        include_recall: false,
      },
    });

    const firstOpts = streamWithConfigMock.mock.calls[0][2] as {
      agent_run_config?: { allowed_tools?: string[] };
    };
    expect(firstOpts.agent_run_config?.allowed_tools).toEqual(expect.arrayContaining([
      "set_env_var",
      "restart_server",
    ]));
  });

  it.each([
    "jira_create_issue",
    "github_create_issue",
    "schedule_task",
    "file_write",
  ])("does not auto-retry after a %s tool loop", async (toolName) => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: `agent-write-loop-guard-${toolName}`,
      name: `Write Loop Guard ${toolName}`,
      identity: "helper",
      instructions: "Be helpful.",
      tools: [toolName],
      model_config_name: null,
    });
    const thread = createThread(`agent-write-loop-guard-${toolName}`);
    const toolArgs = { title: "Repeated side effect", body: "Do it once" };

    streamWithConfigMock.mockImplementationOnce(() => chunks(
      {
        type: "tool_call",
        data: { id: "call-1", name: toolName, arguments: toolArgs },
      },
      { type: "tool_result", data: { id: "call-1", name: toolName, result: { id: "created-1" } } },
      {
        type: "tool_call",
        data: { id: "call-2", name: toolName, arguments: toolArgs },
      },
      { type: "tool_result", data: { id: "call-2", name: toolName, result: { id: "created-2" } } },
      {
        type: "tool_call",
        data: { id: "call-3", name: toolName, arguments: toolArgs },
      },
      { type: "tool_result", data: { id: "call-3", name: toolName, result: { id: "created-3" } } },
      { type: "text_delta", data: { delta: "Creating it now." } },
      {
        type: "done",
        data: {
          message_id: "done-write-loop",
          usage: { input_tokens: 1, output_tokens: 1, source: "estimate" },
          provider: "openai",
          model_id: "gpt-4o-mini",
          model_config_name: "default",
        },
      },
    ));

    const prepared = await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Create the external record once",
      context_profile: {
        include_hot: true,
        include_warm: false,
        include_facts: false,
        include_recall: false,
      },
    });

    const collected = await collectStream(prepared.stream);
    expect(collected.terminal).toBe("done");
    expect(streamWithConfigMock).toHaveBeenCalledTimes(1);
    expect(collected.usedTools).toEqual([toolName, toolName, toolName]);
    expect(collected.assistantContent).toContain("Retry guard skipped automatic retry");
    expect(collected.assistantContent).toContain(toolName);
    expect(collected.assistantContent).not.toContain("↻ Auto-retry");
  });

  // Issues #576 / #577: the output validator (ADR-0037) flags a completed
  // reply as fabricated and auto-retries. Before the fix, the flagged reply
  // and the retry both landed in the persisted/rendered message, glued
  // together with a "↻" separator. The fix discards the flagged reply via
  // a `reset_text` chunk, so only the corrected retry should survive.
  it("discards the flagged reply instead of concatenating it with the retry", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-fabrication-retry",
      name: "Fabrication Retry Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
    });
    const thread = createThread("agent-fabrication-retry");

    streamWithConfigMock
      .mockImplementationOnce(() => chunks(
        { type: "text_delta", data: { delta: "I patched the file to fix the bug." } },
        {
          type: "done",
          data: {
            message_id: "done-fabrication-1",
            usage: { input_tokens: 1, output_tokens: 1, source: "estimate" },
            provider: "openai",
            model_id: "gpt-4o-mini",
            model_config_name: "default",
          },
        },
      ))
      .mockImplementationOnce(() => chunks(
        { type: "text_delta", data: { delta: "Treating this as a proposal since no tool was called: the bug is a missing null check on line 12." } },
        {
          type: "done",
          data: {
            message_id: "done-fabrication-2",
            usage: { input_tokens: 1, output_tokens: 1, source: "estimate" },
            provider: "openai",
            model_id: "gpt-4o-mini",
            model_config_name: "default",
          },
        },
      ));

    const prepared = await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Did you fix the null-check bug?",
      context_profile: {
        include_hot: true,
        include_warm: false,
        include_facts: false,
        include_recall: false,
      },
    });

    const chunkTypes: string[] = [];
    const collected = await collectStream(prepared.stream, {
      onChunk: (chunk) => chunkTypes.push(chunk.type),
    });

    expect(collected.terminal).toBe("done");
    expect(streamWithConfigMock).toHaveBeenCalledTimes(2);
    // The reset_text chunk is what tells the client/persistence buffers to
    // drop the flagged reply — this is the structural fix for issue #576.
    expect(chunkTypes).toContain("reset_text");
    // Only the retry's own text should survive — the flagged reply is gone,
    // and there is no "↻" glue between two copies.
    expect(collected.assistantContent).not.toContain("I patched the file");
    expect(collected.assistantContent).not.toContain("↻");
    expect(collected.assistantContent).toBe(
      "Treating this as a proposal since no tool was called: the bug is a missing null check on line 12.",
    );
  });

  it("keeps the flagged reply when preparing its replacement fails", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-fabrication-prepare-failure",
      name: "Fabrication Prepare Failure Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
    });
    const thread = createThread("agent-fabrication-prepare-failure");

    streamWithConfigMock.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", data: { delta: "I patched the file to fix the bug." } } as StreamChunk;
        deleteModelConfig("default");
        yield {
          type: "done",
          data: {
            message_id: "done-fabrication-prepare-failure",
            usage: { input_tokens: 1, output_tokens: 1, source: "estimate" },
            provider: "openai",
            model_id: "gpt-4o-mini",
            model_config_name: "default",
          },
        } as StreamChunk;
      },
    }));

    const prepared = await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Did you fix the null-check bug?",
      context_profile: {
        include_hot: true,
        include_warm: false,
        include_facts: false,
        include_recall: false,
      },
    });

    const chunkTypes: string[] = [];
    const collected = await collectStream(prepared.stream, {
      onChunk: (chunk) => chunkTypes.push(chunk.type),
    });

    expect(collected.terminal).toBe("error");
    expect(chunkTypes).not.toContain("reset_text");
    expect(chunkTypes).toContain("text_delta");
    expect(collected.assistantContent).toBe("I patched the file to fix the bug.");
  });
});
