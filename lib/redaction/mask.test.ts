import { describe, it, expect } from "vitest";
import { createMaskContext } from "./mask";
import { DEFAULT_REDACTION_CONFIG } from "./patterns";

describe("createMaskContext.maskText", () => {
  it("replaces detected secrets with type-hinted placeholders", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const { text, summary } = ctx.maskText(
      "key sk-ant-abc123def456ghi789jkl000 then 811218-9876 done",
    );
    expect(text).toMatch(/«SECRET:[a-z0-9]+ type=anthropic_api_key»/);
    expect(text).toMatch(/«SECRET:[a-z0-9]+ type=swedish_personnummer»/);
    expect(text).toContain("then");
    expect(summary.find((e) => e.type_hint === "anthropic_api_key")?.count).toBe(1);
    expect(summary.find((e) => e.type_hint === "swedish_personnummer")?.count).toBe(1);
  });

  it("returns no placeholders for clean input", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const { text, summary } = ctx.maskText("just a normal sentence about cats");
    expect(text).toBe("just a normal sentence about cats");
    expect(summary).toHaveLength(0);
  });

  it("uses the same token id for repeated values within a context", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const key = "sk-ant-abc123def456ghi789jkl000";
    const { text } = ctx.maskText(`first ${key} and again ${key}`);
    const ids = [...text.matchAll(/«SECRET:([a-z0-9]+) type=anthropic_api_key»/g)].map(
      (m) => m[1],
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("uses different token ids for different values", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const { text } = ctx.maskText(
      "a sk-ant-abc123def456ghi789jkl000 b sk-ant-zzz123def456ghi789jkl000",
    );
    const ids = [...text.matchAll(/«SECRET:([a-z0-9]+) type=anthropic_api_key»/g)].map(
      (m) => m[1],
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("createMaskContext.rehydrate", () => {
  it("restores original values from placeholders", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const original = "key sk-ant-abc123def456ghi789jkl000 done";
    const { text } = ctx.maskText(original);
    expect(text).not.toBe(original);
    expect(ctx.rehydrate(text)).toBe(original);
  });

  it("rehydrates placeholders embedded in larger strings (the email case)", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const { text } = ctx.maskText("here is your key sk-ant-abc123def456ghi789jkl000");
    // Simulate the model emitting a tool-call body that quotes the placeholder.
    const toolBody = `Subject: API key\nBody: ${
      text.match(/«SECRET:[a-z0-9]+ type=anthropic_api_key»/)![0]
    }`;
    const rehydrated = ctx.rehydrate(toolBody);
    expect(rehydrated).toContain("sk-ant-abc123def456ghi789jkl000");
    expect(rehydrated).not.toMatch(/«SECRET:/);
  });

  it("leaves unknown placeholder ids untouched", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const result = ctx.rehydrate("nothing here «SECRET:zzz type=anthropic_api_key» end");
    // Unknown id stays as-is rather than being silently dropped.
    expect(result).toContain("«SECRET:zzz type=anthropic_api_key»");
  });

  it("is a no-op when nothing has been masked", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const text = "no secrets here";
    expect(ctx.rehydrate(text)).toBe(text);
  });
});

describe("createMaskContext.maskJson", () => {
  it("produces masked JSON text and a summary, skipping allowlisted fields", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const { text, summary } = ctx.maskJson({
      run_id: "01HQX7K3J9V8N2M5P6R4T1Y3W8",
      body: "API_KEY=sk-ant-abc123def456ghi789jkl000",
    });
    expect(text).toContain("01HQX7K3J9V8N2M5P6R4T1Y3W8");
    expect(text).toMatch(/«SECRET:[a-z0-9]+ type=anthropic_api_key»/);
    expect(summary.find((e) => e.type_hint === "anthropic_api_key")?.count).toBe(1);
  });

  it("rehydrates from masked JSON text round-trip", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const { text } = ctx.maskJson({
      body: "key sk-ant-abc123def456ghi789jkl000",
    });
    const rehydrated = ctx.rehydrate(text);
    expect(rehydrated).toContain("sk-ant-abc123def456ghi789jkl000");
  });
});

describe("createMaskContext.hasMaskedValues", () => {
  it("reflects whether any value has been masked", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    expect(ctx.hasMaskedValues()).toBe(false);
    ctx.maskText("nothing");
    expect(ctx.hasMaskedValues()).toBe(false);
    ctx.maskText("key sk-ant-abc123def456ghi789jkl000");
    expect(ctx.hasMaskedValues()).toBe(true);
  });
});
