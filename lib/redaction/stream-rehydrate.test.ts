import { describe, it, expect } from "vitest";
import { StreamRehydrator } from "./stream-rehydrate";
import { createMaskContext } from "./mask";
import { DEFAULT_REDACTION_CONFIG } from "./patterns";

// Fake fixture — synthetic key matching the redaction pattern. Pre-commit
// secret scanner is told to ignore this single line.
const FAKE_ANT = "sk-ant-abc123def456ghi789jkl000"; // jarela-secret-ok

function maskOnce(text: string) {
  const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
  const { text: masked } = ctx.maskText(text);
  return { ctx, masked };
}

describe("StreamRehydrator", () => {
  it("forwards plain text untouched", () => {
    const { ctx } = maskOnce("nothing sensitive here");
    const r = new StreamRehydrator(ctx);
    expect(r.push("hello ")).toBe("hello ");
    expect(r.push("world")).toBe("world");
    expect(r.flush()).toBe("");
  });

  it("rehydrates a placeholder delivered in one delta", () => {
    const original = `key ${FAKE_ANT} done`;
    const { ctx, masked } = maskOnce(original);
    const r = new StreamRehydrator(ctx);
    expect(r.push(masked)).toBe(original);
  });

  it("holds a placeholder until its close arrives across deltas", () => {
    const original = `key ${FAKE_ANT} done`;
    const { ctx, masked } = maskOnce(original);
    const r = new StreamRehydrator(ctx);
    const chunks: string[] = [];
    for (let i = 0; i < masked.length; i += 3) {
      chunks.push(masked.slice(i, i + 3));
    }
    let out = "";
    for (const c of chunks) out += r.push(c);
    out += r.flush();
    expect(out).toBe(original);
  });

  it("emits an unclosed placeholder as-is on flush", () => {
    const { ctx } = maskOnce("");
    const r = new StreamRehydrator(ctx);
    expect(r.push("partial «SECRET:1 type=anth")).toBe("partial ");
    expect(r.flush()).toBe("«SECRET:1 type=anth");
  });

  it("handles multiple placeholders in one stream", () => {
    const ctx = createMaskContext(DEFAULT_REDACTION_CONFIG);
    const original = `first ${FAKE_ANT} second 811218-9876 done`;
    const { text: masked } = ctx.maskText(original);
    const r = new StreamRehydrator(ctx);
    let out = "";
    for (const ch of masked) out += r.push(ch);
    out += r.flush();
    expect(out).toBe(original);
  });
});
