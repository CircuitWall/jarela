import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  activeRuns: 2,
  listener: null as ((event: { type: string; ts?: number; active_runs?: number }) => void) | null,
  unsubscribe: vi.fn(),
  historyEvent: {
    type: "run_completed" as const,
    thread_id: "thread-1",
    agent_id: null,
    status: "done" as const,
    preview: "Finished",
    ts: 10,
  },
}));

vi.mock("@/lib/notifications/bus", () => ({
  recentSince: vi.fn(() => {
    state.listener?.(state.historyEvent);
    return [state.historyEvent];
  }),
  subscribe: (listener: (event: typeof state.historyEvent) => void) => {
    state.listener = listener;
    return state.unsubscribe;
  },
}));

vi.mock("@/lib/agents/run-registry", () => ({
  getActiveRunCount: () => state.activeRuns,
}));

vi.mock("@/lib/scheduler", () => ({ startScheduler: vi.fn() }));
vi.mock("@/lib/bridges/runtime", () => ({ startAllBridges: vi.fn(async () => {}) }));
vi.mock("@/lib/crypto/master-key", () => ({
  isMasterKeyLocked: () => true,
  onMasterKeyUnlocked: () => () => {},
}));

describe("GET /api/v1/events", () => {
  beforeEach(() => {
    state.activeRuns = 2;
    state.listener = null;
    state.unsubscribe.mockClear();
  });

  it("replays notifications once, snapshots activity, and cleans up on cancellation", async () => {
    const { GET } = await import("./route");
    const response = GET(new NextRequest("http://localhost/api/v1/events?since=0"));
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected an SSE response body");
    const decoder = new TextDecoder();
    const readEvent = async () => {
      const { value, done } = await reader.read();
      if (done || !value) throw new Error("Expected an SSE event");
      const data = decoder.decode(value).trim().slice("data: ".length);
      return JSON.parse(data) as { type: string; active_runs?: number };
    };

    expect(await readEvent()).toMatchObject({ type: "run_completed" });
    expect(await readEvent()).toEqual({ type: "activity_update", active_runs: 2 });

    state.listener?.({ type: "activity_update", active_runs: 3 });
    expect(await readEvent()).toEqual({ type: "activity_update", active_runs: 3 });

    await reader.cancel();
    expect(state.unsubscribe).toHaveBeenCalledOnce();
  });
});
