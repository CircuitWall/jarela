import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  withSystemCacheControl,
  withToolsCacheControl,
  withLastToolResultCacheControl,
} from "./anthropic";

describe("withSystemCacheControl", () => {
  it("wraps non-empty text in a TextBlockParam with ephemeral cache_control", () => {
    expect(withSystemCacheControl("you are helpful")).toEqual([
      { type: "text", text: "you are helpful", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("returns undefined for empty string so the system field is omitted", () => {
    expect(withSystemCacheControl("")).toBeUndefined();
  });
});

describe("withToolsCacheControl", () => {
  const tool = (name: string): Anthropic.Tool => ({
    name,
    description: "",
    input_schema: { type: "object", properties: {} } as Anthropic.Tool.InputSchema,
  });

  it("returns the input unchanged when no tools are provided", () => {
    expect(withToolsCacheControl([])).toEqual([]);
  });

  it("marks only the last tool with cache_control", () => {
    const out = withToolsCacheControl([tool("a"), tool("b"), tool("c")]);
    expect(out).toHaveLength(3);
    expect((out[0] as Anthropic.Tool & { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((out[1] as Anthropic.Tool & { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((out[2] as Anthropic.Tool & { cache_control?: unknown }).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("does not mutate the input array", () => {
    const tools = [tool("a"), tool("b")];
    const snapshot = JSON.stringify(tools);
    withToolsCacheControl(tools);
    expect(JSON.stringify(tools)).toBe(snapshot);
  });
});

describe("withLastToolResultCacheControl", () => {
  it("returns messages unchanged when none contain a tool_result", () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    expect(withLastToolResultCacheControl(msgs)).toEqual(msgs);
  });

  it("marks the last tool_result block in the last message that has one", () => {
    const msgs: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "old" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "thinking" }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t2", content: "fresh-A" },
          { type: "tool_result", tool_use_id: "t3", content: "fresh-B" },
        ],
      },
    ];
    const out = withLastToolResultCacheControl(msgs);
    const lastMsgContent = out[out.length - 1].content as Anthropic.ContentBlockParam[];
    expect((lastMsgContent[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((lastMsgContent[1] as { cache_control?: unknown }).cache_control).toEqual({ type: "ephemeral" });
    // Older tool_result on prior message must remain unmarked — only the
    // most recent breakpoint is needed for incremental within-turn caching.
    const firstMsgContent = out[0].content as Anthropic.ContentBlockParam[];
    expect((firstMsgContent[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
  });

  it("does not mutate the input messages array", () => {
    const msgs: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }],
      },
    ];
    const snapshot = JSON.stringify(msgs);
    withLastToolResultCacheControl(msgs);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });
});
