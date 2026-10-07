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
  it("blocks state-changing tools on a completion turn even when the old user request asked for a restart", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({ id: "completion-read-only", name: "Completion", identity: "helper", instructions: "Be helpful.", tools: ["restart_server", "local_exec"], model_config_name: null });
    const thread = createThread("completion-read-only");
    streamWithConfigMock.mockReturnValue(chunks({ type: "done", data: {} }));
    const prepared = await prepareThreadRun({
      thread_id: thread.thread_id, message: "Restart requested earlier.", _system_signal_continuation: true,
      context_profile: { include_hot: true, include_warm: false, include_facts: false, include_recall: false },
    });
    await collectStream(prepared.stream);
    const options = streamWithConfigMock.mock.calls[0][2] as { agent_run_config: { allowed_tools: string[]; tool_permission_map: Array<{ name: string; permission: string; permission_reason: string }> } };
    expect(options.agent_run_config.allowed_tools).not.toContain("restart_server");
    expect(options.agent_run_config.allowed_tools).not.toContain("local_exec");
    expect(options.agent_run_config.tool_permission_map.find((entry) => entry.name === "restart_server"))
      .toMatchObject({ permission: "disabled", permission_reason: "signal_continuation_read_only" });
    expect(options.agent_run_config.tool_permission_map.find((entry) => entry.name === "invoke_tool")?.permission_reason)
      .not.toBe("signal_continuation_read_only");
  });

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

  it("does not hold a run for a Retry-After longer than the automatic retry cap", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-long-retry-after",
      name: "Long Retry-After Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
    });
    const thread = createThread("agent-long-retry-after");
    streamWithConfigMock.mockImplementationOnce(() => chunks(
      { type: "error", data: { code: "rate_limited", message: "429", retry_after_ms: 60_001 } },
    ));

    const prepared = await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Ping",
      context_profile: { include_hot: true, include_warm: false, include_facts: false, include_recall: false },
    });

    const collected = await collectStream(prepared.stream);
    expect(collected.terminal).toBe("error");
    expect(streamWithConfigMock).toHaveBeenCalledTimes(1);
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

  it("applies cost-saving routing and budget caps while retaining one provider retry", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", {
      api_key: "sk-test",
      context_window_tokens: 131_072,
      max_tokens: 8_192,
    }, true);
    upsertModelConfig("m-cheap", "openai", "gpt-4o-mini", {
      api_key: "sk-test",
      context_window_tokens: 131_072,
      max_tokens: 8_192,
    }, false);
    upsertModelConfig("m-quality", "openai", "gpt-4.1", {
      api_key: "sk-test",
      context_window_tokens: 131_072,
      max_tokens: 8_192,
    }, false);
    upsertAgentConfig({
      id: "agent-cost-saving",
      name: "Cost Saving Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
      usage_strategy: "cost_saving",
    });
    const thread = createThread("agent-cost-saving");

    streamWithConfigMock
      .mockImplementationOnce(() => chunks(
        { type: "error", data: { code: "stream_error", message: "connection reset" } },
      ))
      .mockImplementationOnce(() => chunks(
        { type: "error", data: { code: "stream_error", message: "connection reset" } },
      ));

    const prepared = await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Summarize briefly",
      context_profile: { include_hot: true, include_warm: false, include_facts: false, include_recall: false },
    });
    const collected = await collectStream(prepared.stream);

    expect(collected.terminal).toBe("error");
    expect(streamWithConfigMock).toHaveBeenCalledTimes(2);
    expect(prepared.context_snapshot.context_window_tokens).toBe(32_768);
    const firstOptions = streamWithConfigMock.mock.calls[0][2] as {
      agent_run_config: {
        route_decision: { source: string; policy?: string };
        max_output_tokens?: number;
        output_reserve_tokens?: number;
        system_prompt: string;
      };
    };
    expect(firstOptions.agent_run_config.route_decision).toMatchObject({ source: "heuristic", policy: "cheap" });
    expect(firstOptions.agent_run_config.max_output_tokens).toBe(2_048);
    expect(firstOptions.agent_run_config.output_reserve_tokens).toBe(2_048);
    expect(firstOptions.agent_run_config.system_prompt).toContain("Cost-saving response style");
  });

  it("flags a local stall without starting a quality retry under cost-saving", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-cost-saving-stall",
      name: "Cost Saving Stall Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: [],
      model_config_name: null,
      usage_strategy: "cost_saving",
    });
    const thread = createThread("agent-cost-saving-stall");
    streamWithConfigMock.mockReturnValue(chunks(
      { type: "text_delta", data: { delta: "Working on it!" } },
      { type: "done", data: {} },
    ));

    const prepared = await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Do the task",
      context_profile: { include_hot: true, include_warm: false, include_facts: false, include_recall: false },
    });
    const collected = await collectStream(prepared.stream);

    expect(collected.terminal).toBe("done");
    expect(collected.assistantContent).toContain("Automatic quality retry is disabled");
    expect(streamWithConfigMock).toHaveBeenCalledTimes(1);
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

  it("does not let a rejected invoke_tool proxy call satisfy write-evidence — a claimed save that was actually rejected must still trigger the fabrication retry", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-proxy-fabrication",
      name: "Proxy Fabrication Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: ["file_write"],
      model_config_name: null,
    });
    const thread = createThread("agent-proxy-fabrication");

    streamWithConfigMock
      .mockImplementationOnce(() => chunks(
        {
          type: "tool_call",
          data: { id: "call-1", name: "invoke_tool", arguments: { name: "file_write", args_json: "not valid json" } },
        },
        {
          type: "tool_result",
          data: {
            id: "call-1",
            name: "invoke_tool",
            result: { ok: false, tool: "file_write", status: "rejected", error: "args_json must be a JSON object string", error_code: "bad_args_json" },
          },
        },
        { type: "text_delta", data: { delta: "I've saved the file for you." } },
        {
          type: "done",
          data: {
            message_id: "done-proxy-fabrication-1",
            usage: { input_tokens: 1, output_tokens: 1, source: "estimate" },
            provider: "openai",
            model_id: "gpt-4o-mini",
            model_config_name: "default",
          },
        },
      ))
      .mockImplementationOnce(() => chunks(
        { type: "text_delta", data: { delta: "That failed — the arguments weren't valid JSON. Let me retry with correct args." } },
        {
          type: "done",
          data: {
            message_id: "done-proxy-fabrication-2",
            usage: { input_tokens: 1, output_tokens: 1, source: "estimate" },
            provider: "openai",
            model_id: "gpt-4o-mini",
            model_config_name: "default",
          },
        },
      ));

    const prepared = await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Save this note to the file",
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
    // Retried — the rejected proxy call must not have satisfied write-evidence.
    expect(streamWithConfigMock).toHaveBeenCalledTimes(2);
    // Discarded via reset_text (fabrication path), not the "state-changing
    // tools already ran" write-guard skip.
    expect(chunkTypes).toContain("reset_text");
    expect(collected.assistantContent).not.toContain("I've saved the file");
    expect(collected.assistantContent).not.toContain("Retry guard skipped automatic retry");
    expect(collected.assistantContent).toBe("That failed — the arguments weren't valid JSON. Let me retry with correct args.");
  });

  it("aborts the stalled attempt's own signal before starting the tool-loop retry (prevents the abandoned provider call from racing a duplicate attempt)", async () => {
    upsertModelConfig("default", "openai", "gpt-4o-mini", { api_key: "sk-test" }, true);
    upsertAgentConfig({
      id: "agent-loop-abort",
      name: "Loop Abort Agent",
      identity: "helper",
      instructions: "Be helpful.",
      tools: ["web_search"],
      model_config_name: null,
    });
    const thread = createThread("agent-loop-abort");
    const toolArgs = { q: "same query" };

    let firstAttemptSignal: AbortSignal | undefined;
    streamWithConfigMock
      .mockImplementationOnce((_threadId: string, _messages: unknown[], _options: unknown, signal: AbortSignal) => {
        firstAttemptSignal = signal;
        return chunks(
          { type: "tool_call", data: { id: "call-1", name: "web_search", arguments: toolArgs } },
          { type: "tool_call", data: { id: "call-2", name: "web_search", arguments: toolArgs } },
          { type: "tool_call", data: { id: "call-3", name: "web_search", arguments: toolArgs } },
        );
      })
      .mockImplementationOnce((_threadId: string, _messages: unknown[], _options: unknown, _signal: AbortSignal) => {
        // By the time the retry attempt starts, the original (abandoned)
        // attempt's own signal must already be aborted — otherwise its
        // still-running provider call and this new attempt could both
        // execute web_search concurrently.
        expect(firstAttemptSignal?.aborted).toBe(true);
        return chunks({
          type: "done",
          data: {
            message_id: "done-loop-abort",
            usage: { input_tokens: 1, output_tokens: 1, source: "estimate" },
            provider: "openai",
            model_id: "gpt-4o-mini",
            model_config_name: "default",
          },
        });
      });

    const prepared = await prepareThreadRun({
      thread_id: thread.thread_id,
      message: "Search repeatedly",
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
    expect(firstAttemptSignal?.aborted).toBe(true);
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
