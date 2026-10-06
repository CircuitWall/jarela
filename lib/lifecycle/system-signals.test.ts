import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ unlock: vi.fn(), reconcile: vi.fn(), getDb: vi.fn(), locked: vi.fn(() => false), due: vi.fn((): string[] => []), run: vi.fn(async () => ({})), depth: vi.fn(() => 0), defer: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/crypto/master-key", () => ({ onMasterKeyUnlocked: mocks.unlock, isMasterKeyLocked: mocks.locked }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/stores/threads", () => ({ getThread: () => ({ agent_id: "agent-one" }) }));
vi.mock("@/lib/notifications/bus", () => ({ publish: mocks.publish }));
vi.mock("@/lib/stores/system-signals", () => ({ beginSystemOperation: vi.fn(), emitSystemSignal: vi.fn(), reconcileSystemSignals: mocks.reconcile, dueSystemSignalThreads: mocks.due, deferFailedSignalWakeup: mocks.defer }));
vi.mock("@/lib/agents/agent-turn", () => ({ runAgentTurn: mocks.run }));
vi.mock("@/lib/agents/run-queue", () => ({ getQueueDepth: mocks.depth }));
import { runtimeInstanceId, startSystemSignalLifecycle, dispatchSystemSignalWakeups } from "./system-signals";

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).__jarela_system_signal_lifecycle;
  delete (globalThis as unknown as Record<string, unknown>).__jarela_signal_wakeups;
  delete (globalThis as unknown as Record<string, unknown>).__jarela_signal_dispatch_request;
  mocks.due.mockReturnValue([]);
  mocks.locked.mockReturnValue(false);
  mocks.run.mockReset().mockResolvedValue({});
  vi.clearAllMocks();
});

describe("system signal startup", () => {
  it("refreshes the owning chat after a completion turn is persisted", async () => {
    mocks.due.mockReturnValue(["thread-one"]);
    await dispatchSystemSignalWakeups();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "thread_message_added", thread_id: "thread-one", agent_id: "agent-one", source: "system_signal",
    }));
  });

  it("defers wake-ups while locked", async () => {
    mocks.locked.mockReturnValue(true);
    mocks.due.mockReturnValue(["thread-one"]);
    await dispatchSystemSignalWakeups();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("bounds wake-ups and marks continuations so they cannot recursively wake", async () => {
    mocks.due.mockReturnValue(["thread-one", "thread-two", "thread-three"]);
    const pending = Promise.withResolvers<Record<string, unknown>>();
    mocks.run.mockReturnValue(pending.promise);
    await dispatchSystemSignalWakeups();
    await dispatchSystemSignalWakeups();
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ queue_lane: "background", system_signal_continuation: true, persist_user_message: false }));
    pending.resolve({});
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("backs off failed wake preparation instead of looping", async () => {
    mocks.due.mockReturnValue(["thread-one"]);
    mocks.run.mockRejectedValue(new Error("no model available"));
    await dispatchSystemSignalWakeups();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.defer).toHaveBeenCalledWith("thread-one");
  });

  it("waits for protected state unlock and registers once across repeated bootstrap calls", async () => {
    startSystemSignalLifecycle();
    startSystemSignalLifecycle();
    expect(mocks.unlock).toHaveBeenCalledTimes(1);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    const callback = mocks.unlock.mock.calls[0][0] as () => void;
    callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.reconcile).toHaveBeenCalledWith(runtimeInstanceId());
  });
});