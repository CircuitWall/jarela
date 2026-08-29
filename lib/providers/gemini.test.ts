import { afterEach, describe, expect, it, vi } from "vitest";
import { geminiProvider } from "./gemini";
import type { OpenAITool } from "@/lib/tools/types";

const tool: OpenAITool = {
  type: "function",
  function: {
    name: "read_skill",
    description: "Read a skill",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

function sseResponse(payload: unknown): Response {
  const body = new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("geminiProvider thought signatures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps snake_case thought signatures from streaming function calls", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(sseResponse({
      candidates: [{
        content: {
          parts: [{
            functionCall: { name: "read_skill", args: { id: "x" } },
            thought_signature: "sig-stream",
          }],
        },
        finishReason: "STOP",
      }],
    }));

    const events = [];
    for await (const event of geminiProvider.streamInvoke!(
      "gemini-test",
      [{ role: "user", content: "load skill" }],
      { api_key: "AIza-test" },
      [tool],
    )) {
      events.push(event);
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_call_chunk",
      provider_meta: { gemini_thought_signature: "sig-stream" },
    }));
  });

  it("keeps snake_case thought signatures from non-streaming function calls", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            functionCall: { name: "read_skill", args: { id: "x" } },
            thought_signature: "sig-invoke",
          }],
        },
        finishReason: "STOP",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await geminiProvider.invoke!(
      "gemini-test",
      [{ role: "user", content: "load skill" }],
      { api_key: "AIza-test" },
      [tool],
    );

    expect(result.tool_calls[0]).toMatchObject({
      name: "read_skill",
      provider_meta: { gemini_thought_signature: "sig-invoke" },
    });
  });

  it("replays provider metadata as thoughtSignature on functionCall parts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(sseResponse({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    }));

    const events = [];
    for await (const event of geminiProvider.streamInvoke!(
      "gemini-test",
      [{
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "fc_1",
          type: "function",
          function: { name: "read_skill", arguments: "{}" },
          provider_meta: { gemini_thought_signature: "sig-replay" },
        }],
      }],
      { api_key: "AIza-test" },
      [tool],
    )) {
      events.push(event);
    }

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      contents: Array<{ parts: Array<{ functionCall?: unknown; thoughtSignature?: string }> }>;
    };
    expect(body.contents[0].parts).toContainEqual(expect.objectContaining({
      functionCall: { name: "read_skill", args: {} },
      thoughtSignature: "sig-replay",
    }));
    expect(events).toContainEqual({ type: "text", delta: "ok" });
  });
});
