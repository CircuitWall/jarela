// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BootScreen } from "./BootScreen";

const reads = vi.hoisted(() => ({
  profile: vi.fn(),
  agent: vi.fn(),
  thread: vi.fn(),
  messages: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  api: {
    profile: { get: reads.profile },
    agents: { get: reads.agent, getThread: reads.thread },
    threads: { get: reads.messages },
  },
}));
vi.mock("@/components/ui/Logo", () => ({ Logo: () => null }));
vi.mock("@/components/ui/VersionTag", () => ({ VersionTag: () => null }));
vi.mock("@/components/ui/PoweredBy", () => ({ PoweredBy: () => null }));
vi.mock("@/components/ui/WorkflowChecklist", () => ({ WorkflowChecklist: () => null }));

afterEach(() => { vi.useRealTimers(); });

it("does not restart boot prefetch after dismissal when the agent changes", async () => {
  vi.useFakeTimers();
  reads.profile.mockResolvedValue({});
  reads.agent.mockResolvedValue({});
  reads.thread.mockResolvedValue({ thread_id: "thread" });
  reads.messages.mockResolvedValue({});
  const onPickAgent = vi.fn();
  const { rerender, container } = render(
    <BootScreen agents={[]} agentsLoaded activeAgentId="first" onPickAgent={onPickAgent} />,
  );
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(750); });
  expect(container.innerHTML).toBe("");
  rerender(<BootScreen agents={[]} agentsLoaded activeAgentId="second" onPickAgent={onPickAgent} />);
  await act(async () => {});
  expect(reads.agent).toHaveBeenCalledTimes(1);
  expect(reads.agent).toHaveBeenCalledWith("first", { startup: true });
  expect(reads.thread).toHaveBeenCalledTimes(1);
});
