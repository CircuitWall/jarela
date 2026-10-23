import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  wakeups: vi.fn(),
  triggers: vi.fn(),
  health: vi.fn(),
}));

vi.mock("@/lib/documents/indexer", () => ({ indexAllSources: vi.fn() }));
vi.mock("@/lib/triggers", () => ({ runTriggerTick: mocks.triggers, runScheduledTaskFiringNow: vi.fn() }));
vi.mock("@/lib/health/runner", () => ({ runAllHealthProbes: mocks.health }));
vi.mock("@/lib/tools/system/tool-telemetry-issue", () => ({ maybeAutoFileToolTelemetryIssue: vi.fn() }));
vi.mock("@/lib/attachments/spill-gc", () => ({ runSpillFileGc: vi.fn() }));
vi.mock("@/lib/crypto/master-key", () => ({
  isMasterKeyLocked: () => false,
  onMasterKeyUnlocked: vi.fn(),
}));
vi.mock("@/lib/env/config", () => ({ getConfig: () => ({ schedulerTickMs: 30_000 }) }));
vi.mock("@/lib/stores/scheduled-tasks", () => ({ getDueTasks: vi.fn(), markTasksDeferred: vi.fn() }));
vi.mock("@/lib/lifecycle/system-signals", () => ({ dispatchSystemSignalWakeups: mocks.wakeups }));

import { startScheduler, stopScheduler } from "./index";

beforeEach(() => {
  vi.useFakeTimers();
  mocks.wakeups.mockReset().mockResolvedValue(undefined);
  mocks.triggers.mockReset().mockResolvedValue(undefined);
  mocks.health.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["wakeups", "triggers"] as const)("reports a failed %s tick and processes the next tick", async (stage) => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks[stage].mockRejectedValueOnce(new Error("Synthetic tick failure"));
  startScheduler();
  await vi.advanceTimersByTimeAsync(1);

  expect(errorLog).toHaveBeenCalledWith("[scheduler] tick failed:", "Synthetic tick failure");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mocks.wakeups).toHaveBeenCalledTimes(2);
  expect(mocks.triggers).toHaveBeenCalledTimes(stage === "wakeups" ? 1 : 2);
});

it("does not overlap ticks while a previous tick is in flight", async () => {
  let finish: (() => void) | undefined;
  mocks.wakeups.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  startScheduler();
  await vi.advanceTimersByTimeAsync(30_001);
  expect(mocks.wakeups).toHaveBeenCalledOnce();
  finish?.();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mocks.wakeups).toHaveBeenCalledTimes(2);
});
