import { describe, it, expect, vi, beforeEach } from "vitest";

// Toggle the redaction setting per test. The hoist trick: vi.mock factory
// runs before any imports below, but it can reference a top-level let
// thanks to vi.hoisted.
const enabledRef = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/stores/app-settings", () => ({
  isRedactionEnabled: () => enabledRef.value,
}));

import {
  withMaskRun,
  getCurrentMaskContext,
  getMaskRunContext,
  recordSummary,
} from "./context";

// Fake fixture — synthetic key matching the redaction pattern.
const FAKE_ANT = "sk-ant-abc123def456ghi789jkl000"; // jarela-secret-ok

describe("withMaskRun (enabled)", () => {
  beforeEach(() => { enabledRef.value = true; });

  it("makes a MaskContext available inside the callback", () => {
    expect(getCurrentMaskContext()).toBeUndefined();
    withMaskRun(() => {
      const ctx = getCurrentMaskContext();
      expect(ctx).toBeDefined();
      const { text } = ctx!.maskText(`key ${FAKE_ANT}`);
      expect(text).toMatch(/«SECRET:[a-z0-9]+ type=anthropic_api_key[^»]*»/);
    });
  });

  it("propagates the context across awaits inside the callback", async () => {
    await withMaskRun(async () => {
      await Promise.resolve();
      expect(getCurrentMaskContext()).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getCurrentMaskContext()).toBeDefined();
    });
  });

  it("clears the context after the callback returns", () => {
    withMaskRun(() => { /* noop */ });
    expect(getCurrentMaskContext()).toBeUndefined();
  });

  it("recordSummary accumulates per-payload entries; totalSummary aggregates", () => {
    withMaskRun(() => {
      recordSummary("user", [{ type_hint: "anthropic_api_key", count: 1 }]);
      recordSummary("tool:1:input", [
        { type_hint: "anthropic_api_key", count: 2 },
        { type_hint: "swedish_personnummer", count: 1 },
      ]);
      const run = getMaskRunContext()!;
      const total = run.totalSummary();
      expect(total.find((e) => e.type_hint === "anthropic_api_key")?.count).toBe(3);
      expect(total.find((e) => e.type_hint === "swedish_personnummer")?.count).toBe(1);
      expect(run.summaries.size).toBe(2);
    });
  });

  it("recordSummary is a no-op for empty input", () => {
    withMaskRun(() => {
      recordSummary("noop", []);
      expect(getMaskRunContext()!.summaries.size).toBe(0);
    });
  });

  it("recordSummary outside a run is a no-op (no throw)", () => {
    expect(() => recordSummary("orphan", [{ type_hint: "x", count: 1 }])).not.toThrow();
  });
});

describe("withMaskRun (disabled)", () => {
  beforeEach(() => { enabledRef.value = false; });

  it("provides a no-op MaskContext when redaction is off", () => {
    withMaskRun(() => {
      const ctx = getCurrentMaskContext();
      expect(ctx).toBeDefined();
      const { text, summary } = ctx!.maskText(`key ${FAKE_ANT}`);
      expect(text).toBe(`key ${FAKE_ANT}`);
      expect(summary).toEqual([]);
      expect(ctx!.hasMaskedValues()).toBe(false);
    });
  });

  it("rehydrate is identity in the no-op context", () => {
    withMaskRun(() => {
      const ctx = getCurrentMaskContext()!;
      const out = ctx.rehydrate("anything «SECRET:1 type=foo» here");
      expect(out).toBe("anything «SECRET:1 type=foo» here");
    });
  });

  it("totalSummary is empty when redaction is off", () => {
    withMaskRun(() => {
      expect(getMaskRunContext()!.totalSummary()).toEqual([]);
    });
  });
});
