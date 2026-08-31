import { afterEach, describe, it, expect } from "vitest";
import { HumanMessage, AIMessageChunk } from "@langchain/core/messages";
import type { ChatGenerationChunk } from "@langchain/core/outputs";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { JarelaChatModel } from "./jarela-chat-model";
import { resetConfigCache } from "@/lib/env/config";
import type { ModelProvider, OpenAITool, ProviderStreamEvent } from "./types";

function makeProvider(events: ProviderStreamEvent[], onTools?: (tools: OpenAITool[]) => void): ModelProvider {
  return {
    name: "test",
    async chat() { throw new Error("unused"); },
    async *streamInvoke(_modelId, _messages, _params, tools) {
      onTools?.(tools);
      for (const e of events) yield e;
    },
  };
}

function makeTool(index: number): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: `tool_${index}`,
    description: `test tool ${index}`,
    schema: z.object({ value: z.string().optional() }),
    func: async () => "ok",
  });
}

afterEach(() => {
  delete process.env.JARELA_PROVIDER_TOOL_LIMIT;
  resetConfigCache();
});

async function collectChunks(
  model: JarelaChatModel,
  msg = "hello",
): Promise<ChatGenerationChunk[]> {
  const stream = await model.stream([new HumanMessage(msg)]);
  const out: ChatGenerationChunk[] = [];
  for await (const chunk of stream) {
    // model.stream() yields AIMessageChunks at the public API; for the
    // internal generator behavior we test via _streamResponseChunks below.
    out.push({ message: chunk, text: typeof chunk.content === "string" ? chunk.content : "" } as ChatGenerationChunk);
  }
  return out;
}

describe("JarelaChatModel — empty stream handling", () => {
  it("yields a sentinel empty chunk when provider emits only a stop event", async () => {
    const provider = makeProvider([{ type: "stop", reason: "stop" }]);
    const model = new JarelaChatModel({ provider, modelId: "m", params: {} });
    const chunks = await collectChunks(model);
    expect(chunks.length).toBe(1);
    const msg = chunks[0].message as AIMessageChunk;
    expect(msg.content).toBe("");
    expect(msg.additional_kwargs?.empty_stream_reason).toBe("stop");
  });

  it("throws a friendly error when stop reason is 'length' with no content", async () => {
    const provider = makeProvider([{ type: "stop", reason: "length" }]);
    const model = new JarelaChatModel({ provider, modelId: "m", params: {} });
    await expect(collectChunks(model)).rejects.toThrow(/max_tokens/i);
  });

  it("yields a sentinel empty chunk when provider emits no events at all", async () => {
    const provider = makeProvider([]);
    const model = new JarelaChatModel({ provider, modelId: "m", params: {} });
    const chunks = await collectChunks(model);
    expect(chunks.length).toBe(1);
    expect((chunks[0].message as AIMessageChunk).content).toBe("");
  });

  it("does NOT inject a sentinel when the provider produced text", async () => {
    const provider = makeProvider([
      { type: "text", delta: "hi" },
      { type: "stop", reason: "stop" },
    ]);
    const model = new JarelaChatModel({ provider, modelId: "m", params: {} });
    const chunks = await collectChunks(model);
    expect(chunks.length).toBe(1);
    const msg = chunks[0].message as AIMessageChunk;
    expect(msg.content).toBe("hi");
    expect(msg.additional_kwargs?.empty_stream_reason).toBeUndefined();
  });

  it("tags the final chunk with stop_reason='length' when truncated mid-stream", async () => {
    const provider = makeProvider([
      { type: "text", delta: "Row 1\nRow 2\nRow 3" },
      { type: "stop", reason: "length" },
    ]);
    const model = new JarelaChatModel({ provider, modelId: "m", params: {} });
    const chunks = await collectChunks(model);
    // Last chunk should carry the length marker so the agent layer can warn.
    const last = chunks[chunks.length - 1].message as AIMessageChunk;
    expect(last.additional_kwargs?.stop_reason).toBe("length");
  });

  it("does NOT inject a sentinel when only tool_call_chunk events were seen", async () => {
    const provider = makeProvider([
      { type: "tool_call_chunk", index: 0, id: "t1", name: "ping", args_delta: "{}" },
      { type: "stop", reason: "tool_use" },
    ]);
    const model = new JarelaChatModel({ provider, modelId: "m", params: {} });
    const chunks = await collectChunks(model);
    // Real chunks plus optionally a tool-call structuring chunk, but no empty
    // sentinel — the loop should never have considered itself "empty".
    const sentinels = chunks.filter(
      (c) => (c.message as AIMessageChunk).additional_kwargs?.empty_stream_reason !== undefined,
    );
    expect(sentinels.length).toBe(0);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("caps provider tool payloads at the runtime limit", async () => {
    let seenTools: OpenAITool[] = [];
    const provider = makeProvider([{ type: "text", delta: "ok" }], (tools) => { seenTools = tools; });
    const model = new JarelaChatModel({ provider, modelId: "m", params: {} })
      .bindTools(Array.from({ length: 542 }, (_, index) => makeTool(index))) as JarelaChatModel;

    await collectChunks(model);

    expect(seenTools).toHaveLength(512);
    expect(seenTools[0].function.name).toBe("tool_0");
    expect(seenTools.at(-1)?.function.name).toBe("tool_511");
  });

  it("honors JARELA_PROVIDER_TOOL_LIMIT", async () => {
    process.env.JARELA_PROVIDER_TOOL_LIMIT = "3";
    resetConfigCache();
    let seenTools: OpenAITool[] = [];
    const provider = makeProvider([{ type: "text", delta: "ok" }], (tools) => { seenTools = tools; });
    const model = new JarelaChatModel({ provider, modelId: "m", params: {} })
      .bindTools(Array.from({ length: 5 }, (_, index) => makeTool(index))) as JarelaChatModel;

    await collectChunks(model);

    expect(seenTools.map((tool) => tool.function.name)).toEqual(["tool_0", "tool_1", "tool_2"]);
  });

  it("propagates tool_call_chunk provider_meta into additional_kwargs.provider_tool_call_meta", async () => {
    // Gemini streams a thoughtSignature that must be echoed back on the
    // next request. The ChatModel layer parks it in additional_kwargs
    // keyed by tool call id so LangChain's chunk-concat merges cleanly.
    const provider = makeProvider([
      {
        type: "tool_call_chunk",
        index: 0,
        id: "fc_1",
        name: "memory_write",
        args_delta: "{\"k\":\"v\"}",
        provider_meta: { gemini_thought_signature: "sig-abc" },
      },
      { type: "stop", reason: "tool_use" },
    ]);
    const model = new JarelaChatModel({ provider, modelId: "m", params: {} });
    const chunks = await collectChunks(model);
    const tcChunk = chunks.find((c) => {
      const kwargs = (c.message as AIMessageChunk).additional_kwargs as Record<string, unknown> | undefined;
      return kwargs?.provider_tool_call_meta !== undefined;
    });
    expect(tcChunk).toBeDefined();
    const meta = (tcChunk!.message as AIMessageChunk).additional_kwargs?.provider_tool_call_meta as Record<string, Record<string, unknown>>;
    expect(meta.fc_1).toEqual({ gemini_thought_signature: "sig-abc" });
  });

  it("keeps provider_meta after stream aggregation into the final AIMessage", async () => {
    const provider = makeProvider([
      {
        type: "tool_call_chunk",
        index: 0,
        id: "fc_1",
        name: "read_skill",
        args_delta: "{}",
        provider_meta: { gemini_thought_signature: "sig-abc" },
      },
      { type: "stop", reason: "tool_use" },
    ]);
    const model = new JarelaChatModel({ provider, modelId: "m", params: {} })
      .bindTools([makeTool(0)]) as JarelaChatModel;
    const result = await model.invoke([new HumanMessage("load skill")]);

    expect(result.tool_calls?.[0]?.id).toBe("fc_1");
    const meta = result.additional_kwargs?.provider_tool_call_meta as Record<string, Record<string, unknown>> | undefined;
    expect(meta?.fc_1).toEqual({ gemini_thought_signature: "sig-abc" });
  });
});
