import { describe, expect, it } from "vitest";
import { collectStream } from "./stream-collector";
import type { StreamChunk } from "./base";

async function* fromArray(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const c of chunks) yield c;
}

describe("collectStream", () => {
  it("accumulates text_delta and returns terminal=done", async () => {
    const out = await collectStream(fromArray([
      { type: "text_delta", data: { delta: "Hello " } },
      { type: "text_delta", data: { delta: "world" } },
      { type: "done", data: {} },
    ]));
    expect(out.terminal).toBe("done");
    expect(out.assistantContent).toBe("Hello world");
    expect(out.aborted).toBeUndefined();
  });

  it("flags aborted=true when error chunk carries code=aborted", async () => {
    const out = await collectStream(fromArray([
      { type: "text_delta", data: { delta: "I was about to" } },
      { type: "error", data: { message: "Run interrupted by user.", code: "aborted" } },
    ]));
    expect(out.terminal).toBe("error");
    expect(out.aborted).toBe(true);
    expect(out.assistantContent).toBe("I was about to");
    expect(out.errorMessage).toBe("Run interrupted by user.");
  });

  it("leaves aborted unset on generic stream errors", async () => {
    const out = await collectStream(fromArray([
      { type: "text_delta", data: { delta: "partial" } },
      { type: "error", data: { message: "model 500", code: "upstream_error" } },
    ]));
    expect(out.terminal).toBe("error");
    expect(out.aborted).toBeUndefined();
  });

  it("flags aborted=true when the iterator throws an AbortError", async () => {
    async function* throwing(): AsyncIterable<StreamChunk> {
      yield { type: "text_delta", data: { delta: "partial" } };
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    const out = await collectStream(throwing());
    expect(out.terminal).toBe("error");
    expect(out.aborted).toBe(true);
    expect(out.assistantContent).toBe("partial");
  });
});
