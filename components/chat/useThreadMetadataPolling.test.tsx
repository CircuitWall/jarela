// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ metadata: vi.fn() }));
vi.mock("@/api/client", () => ({ api: { threads: { metadata: mocks.metadata } } }));
const { useThreadMetadataPolling } = await import("./useThreadMetadataPolling");

function applier() {
  return {
    setHotSince: vi.fn(), setHotSinceSeq: vi.fn(), setWarmSummary: vi.fn(),
    setWarmSummaryBefore: vi.fn(), setWarmSummaryBeforeSeq: vi.fn(),
    setWarmSummaryComputedAt: vi.fn(), setWarmSummarySourceMessages: vi.fn(),
    setWarmSummarySourceChars: vi.fn(), setContextWindowTokens: vi.fn(),
    setWarmSummaryPending: vi.fn(), setCompactionPending: vi.fn(),
  };
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("thread metadata polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.metadata.mockReset().mockResolvedValue({ hot_since_seq: 4, warm_summary_before_seq: 4 });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "hidden");
  });

  it("uses metadata reads and stops when disabled", async () => {
    const meta = applier();
    const { rerender } = renderHook(({ enabled }) => useThreadMetadataPolling("t1", enabled, meta),
      { initialProps: { enabled: true } });
    await advance(1600);
    expect(mocks.metadata).toHaveBeenCalledWith("t1", expect.any(AbortSignal));
    expect(meta.setHotSinceSeq).toHaveBeenCalledWith(4);
    expect(meta.setWarmSummaryPending).toHaveBeenCalledWith(false);
    rerender({ enabled: false });
    await advance(5000);
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
  });

  it("waits for each response before scheduling another read", async () => {
    let resolve!: (value: object) => void;
    mocks.metadata.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    renderHook(() => useThreadMetadataPolling("t1", true, applier()));
    await advance(8000);
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
    await act(async () => resolve({}));
    await advance(1599);
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mocks.metadata).toHaveBeenCalledTimes(2);
  });

  it("pauses while hidden and refreshes immediately on visibility", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    renderHook(() => useThreadMetadataPolling("t1", true, applier()));
    await advance(5000);
    expect(mocks.metadata).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
  });

  it("does not overlap an in-flight read when the page becomes visible again", async () => {
    let resolve!: (value: object) => void;
    mocks.metadata.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const { unmount } = renderHook(() => useThreadMetadataPolling("t1", true, applier()));
    await advance(1600);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
    await act(async () => resolve({}));
    await advance(1600);
    expect(mocks.metadata).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("uses the latest metadata setters without restarting the polling timer", async () => {
    const first = applier();
    const second = applier();
    const { rerender } = renderHook(({ meta }) => useThreadMetadataPolling("t1", true, meta),
      { initialProps: { meta: first } });
    await advance(800);
    rerender({ meta: second });
    await advance(800);
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
    expect(first.setHotSinceSeq).not.toHaveBeenCalled();
    expect(second.setHotSinceSeq).toHaveBeenCalledWith(4);
  });

  it("aborts and ignores stale responses after switching threads", async () => {
    let resolve!: (value: object) => void;
    mocks.metadata.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const meta = applier();
    const { rerender } = renderHook(({ id }) => useThreadMetadataPolling(id, true, meta),
      { initialProps: { id: "t1" } });
    await advance(1600);
    const signal = mocks.metadata.mock.calls[0][1] as AbortSignal;
    rerender({ id: "t2" });
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ hot_since_seq: 99 }));
    expect(meta.setHotSinceSeq).not.toHaveBeenCalled();
    await advance(1600);
    expect(mocks.metadata).toHaveBeenLastCalledWith("t2", expect.any(AbortSignal));
  });

  it("logs failures and retries without replacing metadata with defaults", async () => {
    const error = new Error("offline");
    mocks.metadata.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const meta = applier();
    renderHook(() => useThreadMetadataPolling("t1", true, meta));
    await advance(1600);
    expect(log).toHaveBeenCalledWith("thread metadata refresh failed", error);
    expect(meta.setHotSinceSeq).not.toHaveBeenCalled();
    await advance(1600);
    expect(meta.setHotSinceSeq).toHaveBeenCalledWith(4);
  });
});
