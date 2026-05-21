import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NotificationEvent } from "./bus";

const KEY = "__jarela_notif_bus";

beforeEach(() => {
  // Force a fresh bus instance: drop both the cached module *and* the
  // globalThis-pinned state the module would otherwise rehydrate from.
  vi.resetModules();
  delete (globalThis as unknown as Record<string, unknown>)[KEY];
});

async function freshBus() {
  return await import("./bus");
}

const ev = (preview: string, ts: number): NotificationEvent => ({
  type: "run_completed",
  thread_id: "t",
  agent_id: null,
  status: "done",
  preview,
  ts,
});

describe("publish + subscribe", () => {
  it("delivers events to subscribers in order", async () => {
    const bus = await freshBus();
    const seen: string[] = [];
    bus.subscribe((e) => {
      if (e.type === "run_completed") seen.push(e.preview);
    });
    bus.publish(ev("a", 1));
    bus.publish(ev("b", 2));
    expect(seen).toEqual(["a", "b"]);
  });

  it("subscribe returns an unsubscribe fn that detaches the listener", async () => {
    const bus = await freshBus();
    const seen: string[] = [];
    const off = bus.subscribe((e) => {
      if (e.type === "run_completed") seen.push(e.preview);
    });
    bus.publish(ev("a", 1));
    off();
    bus.publish(ev("b", 2));
    expect(seen).toEqual(["a"]);
  });

  it("a listener that throws does not break delivery to other listeners", async () => {
    const bus = await freshBus();
    const seen: string[] = [];
    bus.subscribe(() => { throw new Error("boom"); });
    bus.subscribe((e) => { if (e.type === "run_completed") seen.push(e.preview); });
    bus.publish(ev("ok", 1));
    expect(seen).toEqual(["ok"]);
  });
});

describe("recentSince", () => {
  it("returns published events with ts > sinceTs", async () => {
    const bus = await freshBus();
    bus.publish(ev("a", 100));
    bus.publish(ev("b", 200));
    bus.publish(ev("c", 300));

    const since150 = bus.recentSince(150);
    expect(since150.map((e) => (e.type === "run_completed" ? e.preview : ""))).toEqual(["b", "c"]);
  });

  it("returns [] when sinceTs is past every event", async () => {
    const bus = await freshBus();
    bus.publish(ev("a", 100));
    expect(bus.recentSince(999)).toEqual([]);
  });

  it("caps the buffer at the recent limit (50)", async () => {
    const bus = await freshBus();
    for (let i = 0; i < 60; i++) bus.publish(ev(`p${i}`, i + 1));
    const all = bus.recentSince(0);
    expect(all.length).toBe(50);
    // Oldest 10 dropped — buffer should start at p10.
    expect(all[0].type === "run_completed" && all[0].preview).toBe("p10");
    expect(all[49].type === "run_completed" && all[49].preview).toBe("p59");
  });
});
