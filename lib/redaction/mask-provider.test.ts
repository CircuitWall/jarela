import { describe, it, expect, vi } from "vitest";

const enabledRef = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/stores/app-settings", () => ({
  isRedactionEnabled: () => enabledRef.value,
}));

import { withMaskRun } from "./context";
import { maskOutboundText, withRedaction } from "./mask-provider";
import type { InvokeMessage, InvokeResult } from "@/lib/tools/runtime/types";
import type { ModelProvider, ProviderMessage, ProviderStreamEvent } from "@/lib/providers/types";

const FAKE_ANT = "sk-ant-abc123def456ghi789jkl000"; // jarela-secret-ok

function chatProvider(reply: (sent: ProviderMessage[]) => string[]) {
  const sent: ProviderMessage[][] = [];
  const provider: ModelProvider = {
    name: "fake",
    async chat(_model: string, messages: ProviderMessage[]) {
      sent.push(messages);
      const chunks = reply(messages);
      return { stream: (async function* () { yield* chunks; })() };
    },
  };
  return { sent, provider };
}

const noChat = async () => ({ stream: (async function* () {})() });

function split(placeholder: string): [string, string] {
  const mid = Math.floor(placeholder.length / 2);
  return [placeholder.slice(0, mid), placeholder.slice(mid)];
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

describe("withRedaction", () => {
  it("masks chat payloads and rehydrates placeholders split across stream chunks", async () => {
    enabledRef.value = true;
    const { sent, provider } = chatProvider((messages) => {
      const placeholder = String(messages[0].content).match(/«SECRET:[^»]+»/)![0];
      const mid = Math.floor(placeholder.length / 2);
      return ["Summary: ", placeholder.slice(0, mid), placeholder.slice(mid), " done"];
    });
    const { stream } = await withRedaction(provider).chat("m", [{ role: "user", content: `key ${FAKE_ANT}` }], {});
    expect(JSON.stringify(sent)).not.toContain(FAKE_ANT);
    expect(await collect(stream)).toBe(`Summary: ${FAKE_ANT} done`);
    expect(withRedaction(provider).name).toBe("fake");
  });

  it("masks invoke payloads and rehydrates text and tool-call arguments", async () => {
    enabledRef.value = true;
    let sent: InvokeMessage[] = [];
    const provider: ModelProvider = {
      name: "fake",
      chat: noChat,
      async invoke(_model: string, messages: InvokeMessage[]): Promise<InvokeResult> {
        sent = messages;
        const placeholder = String(messages[1].content).match(/«SECRET:[^»]+»/)![0];
        return { text: `uses ${placeholder}`, tool_calls: [{ id: "1", name: "t", arguments: { key: placeholder } }] };
      },
    };
    const result = await withRedaction(provider).invoke!("m", [
      { role: "system", content: "classify" },
      { role: "user", content: `answer mentions ${FAKE_ANT}` },
    ], {}, []);
    expect(JSON.stringify(sent)).not.toContain(FAKE_ANT);
    expect(result.text).toBe(`uses ${FAKE_ANT}`);
    expect(result.tool_calls[0].arguments).toEqual({ key: FAKE_ANT });
  });

  it("reuses the active chat run so placeholder ids match the turn", async () => {
    enabledRef.value = true;
    const { sent, provider } = chatProvider(() => ["ok"]);
    await withMaskRun(async () => {
      const { getMaskRunContext } = await import("./context");
      const runText = getMaskRunContext()!.ctx.maskText(`first ${FAKE_ANT}`).text;
      await collect((await withRedaction(provider).chat("m", [{ role: "user", content: FAKE_ANT }], {})).stream);
      expect(String(sent[0][0].content)).toBe(runText.replace("first ", ""));
    });
  });

  it("passes payloads through unchanged when redaction is disabled", async () => {
    enabledRef.value = false;
    const { sent, provider } = chatProvider(() => ["ok"]);
    await collect((await withRedaction(provider).chat("m", [{ role: "user", content: FAKE_ANT }], {})).stream);
    expect(sent[0][0].content).toBe(FAKE_ANT);
    expect(maskOutboundText(FAKE_ANT)).toBe(FAKE_ANT);
    enabledRef.value = true;
  });

  it("masks streamInvoke payloads and rehydrates split text, thinking, and tool args before stop", async () => {
    enabledRef.value = true;
    let sent: InvokeMessage[] = [];
    const provider: ModelProvider = {
      name: "fake",
      chat: noChat,
      async *streamInvoke(_model: string, messages: InvokeMessage[]): AsyncIterable<ProviderStreamEvent> {
        sent = messages;
        const placeholder = String(messages[0].content).match(/«SECRET:[^»]+»/)![0];
        const [a, b] = split(placeholder);
        yield { type: "thinking", delta: `think ${a}` };
        yield { type: "thinking", delta: b };
        yield { type: "text", delta: `say ${a}` };
        yield { type: "text", delta: `${b} end` };
        yield { type: "tool_call_chunk", index: 0, id: "c1", name: "t" };
        yield { type: "tool_call_chunk", index: 0, args_delta: `{"key":"${a}` };
        // Placeholder still incomplete at stop: the wrapper must flush it first.
        yield { type: "stop", reason: "tool_use" };
        yield { type: "usage", output_tokens: 3 };
      },
    };
    const events: ProviderStreamEvent[] = [];
    for await (const event of withRedaction(provider).streamInvoke!("m", [{ role: "user", content: `key ${FAKE_ANT}` }], {}, [])) {
      events.push(event);
    }
    expect(JSON.stringify(sent)).not.toContain(FAKE_ANT);
    const joined = (type: "text" | "thinking") =>
      events.filter((e) => e.type === type).map((e) => (e as { delta: string }).delta).join("");
    expect(joined("thinking")).toBe(`think ${FAKE_ANT}`);
    expect(joined("text")).toBe(`say ${FAKE_ANT} end`);
    const stopAt = events.findIndex((e) => e.type === "stop");
    const args = events.slice(0, stopAt)
      .filter((e) => e.type === "tool_call_chunk")
      .map((e) => (e as { args_delta?: string }).args_delta ?? "").join("");
    // A truncated placeholder can't be resolved, so the raw fragment is flushed as-is.
    expect(args.startsWith('{"key":"«SECRET:')).toBe(true);
    expect(events.find((e) => e.type === "tool_call_chunk")).toMatchObject({ id: "c1", name: "t" });
    expect(events[events.length - 1]).toEqual({ type: "usage", output_tokens: 3 });
  });

  it("rehydrates complete tool arguments split across deltas", async () => {
    enabledRef.value = true;
    const provider: ModelProvider = {
      name: "fake",
      chat: noChat,
      async *streamInvoke(_model: string, messages: InvokeMessage[]): AsyncIterable<ProviderStreamEvent> {
        const [a, b] = split(String(messages[0].content).match(/«SECRET:[^»]+»/)![0]);
        yield { type: "tool_call_chunk", index: 0, id: "c1", name: "t", args_delta: `{"key":"${a}` };
        yield { type: "tool_call_chunk", index: 0, args_delta: `${b}"}` };
        yield { type: "stop", reason: "tool_use" };
      },
    };
    let args = "";
    for await (const event of withRedaction(provider).streamInvoke!("m", [{ role: "user", content: FAKE_ANT }], {}, [])) {
      if (event.type === "tool_call_chunk") args += event.args_delta ?? "";
    }
    expect(JSON.parse(args)).toEqual({ key: FAKE_ANT });
  });

  it("masks embedding inputs", async () => {
    enabledRef.value = true;
    let inputs: string[] = [];
    const provider: ModelProvider = {
      name: "fake",
      chat: noChat,
      async embed(_model: string, values: string[]) {
        inputs = values;
        return values.map(() => [0]);
      },
    };
    await withRedaction(provider).embed!("m", [`memory ${FAKE_ANT}`, "plain"], {});
    expect(inputs[0]).not.toContain(FAKE_ANT);
    expect(inputs[1]).toBe("plain");
  });

  it("does not re-mask text that is already masked", async () => {
    enabledRef.value = true;
    await withMaskRun(async () => {
      const { getMaskRunContext } = await import("./context");
      const once = getMaskRunContext()!.ctx.maskText(`key ${FAKE_ANT}`).text;
      const { sent, provider } = chatProvider(() => ["ok"]);
      await collect((await withRedaction(provider).chat("m", [{ role: "user", content: once }], {})).stream);
      expect(sent[0][0].content).toBe(once);
    });
  });

  it("masks direct outbound text and makes it speakable for TTS", () => {
    enabledRef.value = true;
    expect(maskOutboundText(`draw ${FAKE_ANT}`)).toMatch(/^draw «SECRET:/);
    expect(maskOutboundText(`read ${FAKE_ANT}`, { speakable: true })).toBe("read redacted");
  });
});
