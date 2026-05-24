import { describe, it, expect } from "vitest";
import { parseMockDirectives, mockProvider } from "./mock";
import type { InvokeMessage } from "./types";

async function collectStream(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

describe("parseMockDirectives", () => {
  it("returns empty object when no directives present", () => {
    expect(parseMockDirectives("hello world")).toEqual({});
  });

  it("parses reply directive", () => {
    expect(parseMockDirectives("MOCK:reply=hi there")).toEqual({ reply: "hi there" });
  });

  it("parses echo as boolean", () => {
    expect(parseMockDirectives("MOCK:echo")).toEqual({ echo: true });
  });

  it("parses tool with json args", () => {
    expect(parseMockDirectives(`MOCK:tool=web_search:{"q":"foo"}`)).toEqual({
      tool: { name: "web_search", args: { q: "foo" } },
    });
  });

  it("parses tool with no args", () => {
    expect(parseMockDirectives("MOCK:tool=ping")).toEqual({
      tool: { name: "ping", args: {} },
    });
  });

  it("parses slow as number", () => {
    expect(parseMockDirectives("MOCK:slow=25")).toEqual({ slowMs: 25 });
  });

  it("ignores invalid stop values", () => {
    expect(parseMockDirectives("MOCK:stop=bogus")).toEqual({});
  });

  it("parses multiple directives across lines", () => {
    const d = parseMockDirectives("hello\nMOCK:reply=ok\nMOCK:slow=5\ntail");
    expect(d).toEqual({ reply: "ok", slowMs: 5 });
  });
});

describe("mockProvider.chat", () => {
  it("streams the default greeting echoing the user message", async () => {
    const res = await mockProvider.chat("mock-1", [
      { role: "user", content: "ping" },
    ], {});
    const out = await collectStream(res.stream);
    expect(out).toBe("Hello from the mock provider. You said: ping");
  });

  it("honours MOCK:reply", async () => {
    const res = await mockProvider.chat("mock-1", [
      { role: "user", content: "MOCK:reply=custom answer" },
    ], {});
    expect(await collectStream(res.stream)).toBe("custom answer");
  });

  it("throws when MOCK:error is set", async () => {
    await expect(
      mockProvider.chat("mock-1", [{ role: "user", content: "MOCK:error=boom" }], {}),
    ).rejects.toThrow("boom");
  });
});

describe("mockProvider.invoke", () => {
  it("returns plain text reply by default", async () => {
    const r = await mockProvider.invoke!("mock-1", [
      { role: "user", content: "hello" } as InvokeMessage,
    ], {}, []);
    expect(r.text).toContain("hello");
    expect(r.tool_calls).toEqual([]);
    expect(r.stop_reason).toBe("stop");
  });

  it("emits a tool call when directed", async () => {
    const r = await mockProvider.invoke!("mock-1", [
      { role: "user", content: `MOCK:tool=web_search:{"q":"foo"}` } as InvokeMessage,
    ], {}, []);
    expect(r.text).toBeNull();
    expect(r.tool_calls).toEqual([{ id: "mock-1", name: "web_search", arguments: { q: "foo" } }]);
    expect(r.stop_reason).toBe("tool_use");
  });
});

describe("mockProvider.embed", () => {
  it("returns deterministic L2-normalised vectors of fixed dimension", async () => {
    const a1 = (await mockProvider.embed!("mock-1", ["hello"], {}))[0];
    const a2 = (await mockProvider.embed!("mock-1", ["hello"], {}))[0];
    const b = (await mockProvider.embed!("mock-1", ["world"], {}))[0];
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
    expect(a1.length).toBe(384);
    const norm = Math.sqrt(a1.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});
