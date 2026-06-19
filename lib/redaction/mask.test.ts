import { describe, it, expect } from "vitest";
import { createMaskContext } from "./mask";
import { DEFAULT_REDACTION_CONFIG } from "./patterns";

// Fake fixtures — synthetic strings that match patterns being tested.
// Pre-commit secret scanner ignores these two lines; everywhere else
// interpolates the constants so no other line trips the scan.
const FAKE_ANT = "sk-ant-abc123def456ghi789jkl000"; // jarela-secret-ok
const FAKE_ANT_2 = "sk-ant-zzz123def456ghi789jkl000"; // jarela-secret-ok

function maskOnce(text: string) {
  const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
  const { text: masked } = ctx.maskText(text);
  return { ctx, masked };
}

describe("createMaskContext.maskText", () => {
  it("replaces detected secrets with type-hinted placeholders", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const { text, summary } = ctx.maskText(
      `key ${FAKE_ANT} then 811218-9876 done`,
    );
    expect(text).toMatch(/«SECRET:[a-z0-9]+ type=anthropic_api_key[^»]*»/);
    expect(text).toMatch(/«SECRET:[a-z0-9]+ type=swedish_personnummer[^»]*»/);
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
    const { text } = ctx.maskText(`first ${FAKE_ANT} and again ${FAKE_ANT}`);
    const ids = [...text.matchAll(/«SECRET:([a-z0-9]+) type=anthropic_api_key[^»]*»/g)].map(
      (m) => m[1],
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("uses different token ids for different values", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const { text } = ctx.maskText(`a ${FAKE_ANT} b ${FAKE_ANT_2}`);
    const ids = [...text.matchAll(/«SECRET:([a-z0-9]+) type=anthropic_api_key[^»]*»/g)].map(
      (m) => m[1],
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("createMaskContext.rehydrate", () => {
  it("restores original values from placeholders", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const original = `key ${FAKE_ANT} done`;
    const { text } = ctx.maskText(original);
    expect(text).not.toBe(original);
    expect(ctx.rehydrate(text)).toBe(original);
  });

  it("rehydrates placeholders embedded in larger strings (the email case)", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const { text } = ctx.maskText(`here is your key ${FAKE_ANT}`);
    // Simulate the model emitting a tool-call body that quotes the placeholder.
    const toolBody = `Subject: API key\nBody: ${
      text.match(/«SECRET:[a-z0-9]+ type=anthropic_api_key[^»]*»/)![0]
    }`;
    const rehydrated = ctx.rehydrate(toolBody);
    expect(rehydrated).toContain(FAKE_ANT);
    expect(rehydrated).not.toMatch(/«SECRET:/);
  });

  it("leaves unknown placeholder ids untouched", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const result = ctx.rehydrate("nothing here «SECRET:zzz type=anthropic_api_key len=30 head=sk tail=00» end");
    expect(result).toContain("«SECRET:zzz type=anthropic_api_key len=30 head=sk tail=00»");
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
      body: `API_KEY=${FAKE_ANT}`,
    });
    expect(text).toContain("01HQX7K3J9V8N2M5P6R4T1Y3W8");
    expect(text).toMatch(/«SECRET:[a-z0-9]+ type=anthropic_api_key[^»]*»/);
    expect(summary.find((e) => e.type_hint === "anthropic_api_key")?.count).toBe(1);
  });

  it("rehydrates from masked JSON text round-trip", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const { text } = ctx.maskJson({ body: `key ${FAKE_ANT}` });
    const rehydrated = ctx.rehydrate(text);
    expect(rehydrated).toContain(FAKE_ANT);
  });
});

describe("placeholder fingerprint", () => {
  it("includes len, head, and tail so the agent can compare secrets across runs", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const { text } = ctx.maskText(`key ${FAKE_ANT} end`);
    const placeholder = text.match(/«SECRET:[^»]+»/)![0];
    // Format: «SECRET:<id> type=<hint> len=<n> head=<h> tail=<t>»
    expect(placeholder).toMatch(/ len=\d+ /);
    expect(placeholder).toMatch(/ head=[^ »]+ /);
    expect(placeholder).toMatch(/ tail=[^»]*»$/);
    const len = Number(placeholder.match(/ len=(\d+) /)![1]);
    expect(len).toBe(FAKE_ANT.length);
    const head = placeholder.match(/ head=([^ ]+) /)![1];
    const tail = placeholder.match(/ tail=([^»]*)»$/)![1];
    expect(FAKE_ANT.startsWith(head)).toBe(true);
    expect(FAKE_ANT.endsWith(tail)).toBe(true);
    // Exposure must stay ≤ 10% rounded down, but at least 1+1 chars.
    const exposed = head.length + tail.length;
    expect(exposed).toBeGreaterThanOrEqual(2);
    expect(exposed).toBeLessThanOrEqual(Math.max(2, Math.floor(len * 0.1)));
  });

  it("emits identical fingerprints for the same value (so the agent can match across placeholders)", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const { text } = ctx.maskText(`a ${FAKE_ANT} b ${FAKE_ANT}`);
    const placeholders = [...text.matchAll(/«SECRET:[^»]+»/g)].map((m) => m[0]);
    expect(placeholders).toHaveLength(2);
    expect(placeholders[0]).toBe(placeholders[1]);
  });

  it("emits different fingerprints for different values", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const { text } = ctx.maskText(`a ${FAKE_ANT} b ${FAKE_ANT_2}`);
    const placeholders = [...text.matchAll(/«SECRET:[^»]+»/g)].map((m) => m[0]);
    expect(placeholders).toHaveLength(2);
    // Same len + type but different head/tail → distinct fingerprints overall.
    expect(placeholders[0]).not.toBe(placeholders[1]);
  });
});

describe("createMaskContext.hasMaskedValues", () => {
  it("reflects whether any value has been masked", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    expect(ctx.hasMaskedValues()).toBe(false);
    ctx.maskText("nothing");
    expect(ctx.hasMaskedValues()).toBe(false);
    // suppress maskOnce unused-import lint
    expect(typeof maskOnce).toBe("function");
    ctx.maskText(`key ${FAKE_ANT}`);
    expect(ctx.hasMaskedValues()).toBe(true);
  });
});
