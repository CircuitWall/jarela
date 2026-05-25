import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessageChunk } from "@langchain/core/messages";
import type { ChatGenerationChunk } from "@langchain/core/outputs";
import { JarelaChatModel } from "./jarela-chat-model";
import type { ModelProvider, ProviderStreamEvent } from "./types";

function makeProvider(events: ProviderStreamEvent[]): ModelProvider {
  return {
    name: "test",
    async chat() { throw new Error("unused"); },
    async *streamInvoke() {
      for (const e of events) yield e;
    },
  };
}

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
});
