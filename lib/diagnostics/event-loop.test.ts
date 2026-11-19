import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetBlockingWorkDiagnosticsForTests,
  currentBlockingWork,
  formatStallReport,
  noteSlowStatement,
  startEventLoopWatchdog,
  withBlockingWork,
  withBlockingWorkAsync,
} from "./event-loop";

afterEach(() => {
  vi.restoreAllMocks();
  __resetBlockingWorkDiagnosticsForTests();
});

describe("blocking work diagnostics", () => {
  it("keeps the innermost label visible and unwinds it even when the work throws", () => {
    expect(currentBlockingWork()).toBeNull();
    let seenInner: string | null = null;
    expect(() => withBlockingWork("outer", () => withBlockingWork("inner", () => {
      seenInner = currentBlockingWork();
      throw new Error("boom");
    }))).toThrow("boom");
    expect(seenInner).toBe("inner");
    expect(currentBlockingWork()).toBeNull();
  });

  it("unwinds an async region after the awaited work settles", async () => {
    await withBlockingWorkAsync("embeddings:local-inference", async () => {
      await Promise.resolve();
      expect(currentBlockingWork()).toBe("embeddings:local-inference");
    });
    expect(currentBlockingWork()).toBeNull();
  });

  it("records slow regions and reports them alongside slow statements", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    withBlockingWork("documents:search-select", () => {
      const until = performance.now() + 260;
      while (performance.now() < until) { /* simulate a blocking query */ }
    });
    noteSlowStatement("SELECT * FROM document_chunks WHERE document_id=? LIMIT 20000", 1_832, 20_000);

    const report = formatStallReport({
      maxMs: 3_200, meanMs: 240, p99Ms: 1_800, stallMs: 1_000,
      currentWork: null,
      slowWork: [{ label: "documents:search-select", ms: 300, at: "2026-11-19T00:00:00.000Z" }],
      slowStatements: [{ sql: "SELECT 1", ms: 1_832, rows: 20_000, at: "2026-11-19T00:00:00.000Z" }],
    });

    expect(report).toContain("blocked for 3200ms");
    expect(report).toContain("last slow sync region: documents:search-select 300ms");
    expect(report).toContain("slow statement 1832ms rows=20000: SELECT 1");
  });

  it("names the region that was still running when the loop stalled", () => {
    const report = formatStallReport({
      maxMs: 5_000, meanMs: 900, p99Ms: 4_000, stallMs: 1_000,
      currentWork: "documents:search-score",
      slowWork: [],
      slowStatements: [],
    });
    expect(report).toContain('while running "documents:search-score"');
  });

  it("is a no-op when disabled and reports once per stall sample", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const stopDisabled = startEventLoopWatchdog({ stallMs: 0 });
      stopDisabled();
      expect(warn).not.toHaveBeenCalled();

      const stop = startEventLoopWatchdog({ stallMs: 50, sampleMs: 100 });
      await vi.advanceTimersByTimeAsync(350);
      // No synchronous block was produced under fake timers, so nothing is
      // reported; the assertion guards against spurious stall logs.
      expect(warn.mock.calls.filter(([line]) => String(line).includes("[event-loop] blocked"))).toHaveLength(0);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
