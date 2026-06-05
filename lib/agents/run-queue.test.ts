import { describe, it, expect, afterEach } from "vitest";
import { enqueueThreadRun, getQueueDepth, QueueFullError, __resetForTests } from "./run-queue";

afterEach(() => {
  __resetForTests();
});

describe("enqueueThreadRun", () => {
  it("runs a single job immediately and resolves its result", async () => {
    const { result, position } = enqueueThreadRun("t1", "user", async () => 42);
    expect(position).toBe(0);
    await expect(result).resolves.toBe(42);
  });

  it("serialises jobs for the same thread in FIFO order", async () => {
    const events: string[] = [];
    const release: Array<() => void> = [];
    const make = (id: string) => async () => {
      events.push(`start:${id}`);
      await new Promise<void>((res) => release.push(res));
      events.push(`end:${id}`);
      return id;
    };

    const a = enqueueThreadRun("t1", "user", make("a"));
    const b = enqueueThreadRun("t1", "user", make("b"));
    const c = enqueueThreadRun("t1", "user", make("c"));

    expect(a.position).toBe(0);
    expect(b.position).toBe(1);
    expect(c.position).toBe(2);

    // Wait a tick so the first job's start event fires.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["start:a"]);

    release[0]!();
    await a.result;
    expect(events).toEqual(["start:a", "end:a", "start:b"]);

    release[1]!();
    await b.result;
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c"]);

    release[2]!();
    await c.result;
    expect(events).toEqual([
      "start:a", "end:a",
      "start:b", "end:b",
      "start:c", "end:c",
    ]);
  });

  it("different threads run in parallel", async () => {
    const order: string[] = [];
    const release: Array<() => void> = [];
    const a = enqueueThreadRun("t1", "user", async () => {
      order.push("a-start");
      await new Promise<void>((res) => release.push(res));
      order.push("a-end");
    });
    const b = enqueueThreadRun("t2", "user", async () => {
      order.push("b-start");
      await new Promise<void>((res) => release.push(res));
      order.push("b-end");
    });

    // Yield so both start.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a-start", "b-start"]);

    release[1]!();
    await b.result;
    release[0]!();
    await a.result;
    expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
  });

  it("a failing job does not block the next job in the queue", async () => {
    const a = enqueueThreadRun("t1", "user", async () => {
      throw new Error("boom");
    });
    const b = enqueueThreadRun("t1", "user", async () => "after-boom");

    await expect(a.result).rejects.toThrow("boom");
    await expect(b.result).resolves.toBe("after-boom");
  });

  it("rejects with QueueFullError once depth exceeds maxDepth", async () => {
    // Synchronously enqueue maxDepth jobs — depth is bumped at enqueue
    // time, before any runner microtask fires, so the 4th call sees the
    // full queue and throws.
    const jobs = [];
    for (let i = 0; i < 3; i++) {
      jobs.push(enqueueThreadRun("t1", "user", async () => i, { maxDepth: 3 }));
    }
    expect(() => enqueueThreadRun("t1", "user", async () => 99, { maxDepth: 3 })).toThrow(QueueFullError);
    expect(getQueueDepth("t1")).toBe(3);
    await Promise.all(jobs.map((j) => j.result));
    expect(getQueueDepth("t1")).toBe(0);
  });

  it("getQueueDepth returns 0 after all jobs settle", async () => {
    const a = enqueueThreadRun("t1", "user", async () => "x");
    const b = enqueueThreadRun("t1", "user", async () => "y");
    await Promise.all([a.result, b.result]);
    expect(getQueueDepth("t1")).toBe(0);
  });
});
