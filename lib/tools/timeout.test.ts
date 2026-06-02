import { describe, expect, it, vi } from "vitest";
import { withToolTimeout, ToolTimeoutError } from "./timeout";

describe("withToolTimeout", () => {
  it("returns the task's value when it completes in time", async () => {
    const v = await withToolTimeout(async () => 42, {
      toolName: "demo",
      timeoutMs: 1000,
    });
    expect(v).toBe(42);
  });

  it("throws ToolTimeoutError when the task exceeds the deadline", async () => {
    const slow = (signal: AbortSignal) =>
      new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => resolve(1), 200);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      });
    await expect(
      withToolTimeout(slow, { toolName: "slow", timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(ToolTimeoutError);
  });

  it("aborts the task's signal when the deadline fires", async () => {
    const sawAbort = vi.fn();
    const task = (signal: AbortSignal) =>
      new Promise<number>((_, reject) => {
        signal.addEventListener("abort", () => {
          sawAbort();
          reject(new Error("aborted by timeout"));
        });
        // Never resolve — only abort can end this.
        setTimeout(() => {}, 10_000).unref?.();
      });
    await expect(
      withToolTimeout(task, { toolName: "wedged", timeoutMs: 15 }),
    ).rejects.toBeInstanceOf(ToolTimeoutError);
    expect(sawAbort).toHaveBeenCalled();
  });

  it("re-throws AbortError when the upstream run signal aborts first", async () => {
    const upstream = new AbortController();
    const task = (signal: AbortSignal) =>
      new Promise<number>((_, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error(
            typeof signal.reason === "string" ? signal.reason : "aborted",
          );
          err.name = "AbortError";
          reject(err);
        });
      });
    setTimeout(() => upstream.abort("user_interrupted"), 5);
    await expect(
      withToolTimeout(task, {
        toolName: "long",
        timeoutMs: 5_000,
        runSignal: upstream.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("forwards an already-aborted upstream signal immediately", async () => {
    const upstream = new AbortController();
    upstream.abort("pre_aborted");
    const task = (signal: AbortSignal) =>
      new Promise<number>((resolve, reject) => {
        if (signal.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        } else {
          resolve(1);
        }
      });
    await expect(
      withToolTimeout(task, {
        toolName: "preempted",
        timeoutMs: 1_000,
        runSignal: upstream.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("propagates an arbitrary task error unchanged", async () => {
    await expect(
      withToolTimeout(
        async () => {
          throw new Error("boom");
        },
        { toolName: "explode", timeoutMs: 1_000 },
      ),
    ).rejects.toThrow("boom");
  });

  it("treats timeoutMs <= 0 as no-op (no deadline)", async () => {
    const v = await withToolTimeout(
      (signal) => Promise.resolve(signal.aborted ? -1 : 1),
      { toolName: "off", timeoutMs: 0 },
    );
    expect(v).toBe(1);
  });
});
