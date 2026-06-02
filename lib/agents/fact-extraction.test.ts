import { describe, it, expect, vi } from "vitest";
import {
  parseFactList,
  extractFactsFromTranscript,
  FACT_CONFIDENCE_THRESHOLD,
} from "./fact-extraction";
import type { ModelProvider, ProviderMessage, ProviderParams } from "@/lib/providers/types";

describe("parseFactList", () => {
  it("parses a clean JSON array", () => {
    const out = parseFactList(`[{"key":"a","value":"alpha","confidence":0.9}]`);
    expect(out).toEqual([{ key: "a", value: "alpha", confidence: 0.9 }]);
  });

  it("strips ```json fences", () => {
    const raw = "```json\n[{\"key\":\"x\",\"value\":\"v\",\"confidence\":0.8}]\n```";
    expect(parseFactList(raw)).toHaveLength(1);
  });

  it("ignores prose around the array", () => {
    const raw = `Sure, here are the facts:\n[{"key":"k","value":"v","confidence":0.85}]\nLet me know.`;
    expect(parseFactList(raw)).toEqual([{ key: "k", value: "v", confidence: 0.85 }]);
  });

  it("returns [] on missing array", () => {
    expect(parseFactList("no facts found")).toEqual([]);
  });

  it("returns [] on malformed JSON", () => {
    expect(parseFactList("[{key: a}")).toEqual([]);
  });

  it("drops entries missing required fields", () => {
    const raw = `[
      {"key":"ok","value":"v","confidence":0.8},
      {"key":"","value":"v","confidence":0.9},
      {"key":"x","value":"","confidence":0.9},
      {"key":"y","value":"v"},
      {"key":"z","value":"v","confidence":"high"}
    ]`;
    const out = parseFactList(raw);
    expect(out).toEqual([{ key: "ok", value: "v", confidence: 0.8 }]);
  });

  it("rejects oversized fields", () => {
    const longKey = "a".repeat(100);
    const longVal = "v".repeat(500);
    const raw = `[
      {"key":"${longKey}","value":"v","confidence":0.9},
      {"key":"k","value":"${longVal}","confidence":0.9},
      {"key":"k2","value":"v2","confidence":0.9}
    ]`;
    const out = parseFactList(raw);
    expect(out).toEqual([{ key: "k2", value: "v2", confidence: 0.9 }]);
  });

  it("clamps confidence to [0, 1]", () => {
    const raw = `[
      {"key":"a","value":"v","confidence":1.5},
      {"key":"b","value":"v","confidence":-0.3}
    ]`;
    const out = parseFactList(raw);
    expect(out[0].confidence).toBe(1);
    expect(out[1].confidence).toBe(0);
  });

  it("returns [] on empty input", () => {
    expect(parseFactList("")).toEqual([]);
    expect(parseFactList("   ")).toEqual([]);
  });

  it("returns [] when the parsed JSON isn't an array", () => {
    expect(parseFactList(`{"key":"a","value":"v","confidence":0.9}`)).toEqual([]);
  });
});

describe("extractFactsFromTranscript", () => {
  function fakeProvider(reply: string): Pick<ModelProvider, "chat"> {
    const chat = vi.fn(async (_modelId: string, _messages: ProviderMessage[], _params: ProviderParams) => {
      async function* gen() { yield reply; }
      return { stream: gen() };
    });
    return { chat } as unknown as Pick<ModelProvider, "chat">;
  }

  it("returns facts ≥ confidence threshold", async () => {
    const provider = fakeProvider(`[
      {"key":"strong","value":"v","confidence":0.9},
      {"key":"weak","value":"v","confidence":0.5}
    ]`);
    const out = await extractFactsFromTranscript(provider, "m", {}, "alpha\nbeta");
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("strong");
  });

  it("returns [] on empty transcript without calling provider", async () => {
    const provider = fakeProvider(`[]`);
    const out = await extractFactsFromTranscript(provider, "m", {}, "   ");
    expect(out).toEqual([]);
    expect((provider.chat as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("returns [] on provider error (best-effort)", async () => {
    const chat = vi.fn(async () => { throw new Error("provider down"); });
    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    const out = await extractFactsFromTranscript(provider, "m", {}, "transcript");
    expect(out).toEqual([]);
  });

  it("returns [] when the model produces no JSON array", async () => {
    const out = await extractFactsFromTranscript(fakeProvider("I cannot extract facts."), "m", {}, "t");
    expect(out).toEqual([]);
  });

  it("threshold constant is conservative (≥ 0.7)", () => {
    expect(FACT_CONFIDENCE_THRESHOLD).toBeGreaterThanOrEqual(0.7);
  });
});
