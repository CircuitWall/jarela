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
const { upsertModelConfig } = await import("@/lib/stores/model-config");
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
});