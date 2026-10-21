// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
beforeEach(() => { vi.clearAllMocks(); });

it("offers a direct path to create an agent when none are configured", () => {
  const onCreateAgent = vi.fn();
  render(
    <BootScreen
      agents={[]}
      agentsLoaded
      activeAgentId={null}
      onPickAgent={vi.fn()}
      onCreateAgent={onCreateAgent}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Create an agent" }));
  expect(onCreateAgent).toHaveBeenCalledOnce();
});

it("shows one pulsing current-action line while agents load", () => {
  const { container } = render(
    <BootScreen agents={[]} agentsLoaded={false} activeAgentId={null} onPickAgent={vi.fn()} onCreateAgent={vi.fn()} />,
  );

  expect(screen.getByText("Loading your agents")).toBeTruthy();
  expect(container.querySelectorAll(".animate-pulse")).toHaveLength(1);
  expect(container.querySelector(".animate-pulse")?.classList.contains("font-serif")).toBe(true);
});

it("pulses one startup label at a time and advances as requests settle", async () => {
  let finishProfile!: (value: {}) => void;
  let finishAgent!: (value: {}) => void;
  let finishThread!: (value: { thread_id: string }) => void;
  let finishMessages!: (value: {}) => void;
  reads.profile.mockReturnValue(new Promise((resolve) => { finishProfile = resolve; }));
  reads.agent.mockReturnValue(new Promise((resolve) => { finishAgent = resolve; }));
  reads.thread.mockReturnValue(new Promise((resolve) => { finishThread = resolve; }));
  reads.messages.mockReturnValue(new Promise((resolve) => { finishMessages = resolve; }));

  render(
    <BootScreen
      agents={[]}
      agentsLoaded
      activeAgentId="agent-1"
      onPickAgent={vi.fn()}
      onCreateAgent={vi.fn()}
    />,
  );

  expect(document.querySelectorAll(".animate-pulse")).toHaveLength(1);
  expect(document.querySelector(".animate-pulse")?.textContent).toBe("Setting up your profile");

  await act(async () => finishProfile({}));
  expect(document.querySelector(".animate-pulse")?.textContent).toBe("Getting your agent ready");

  await act(async () => finishAgent({}));
  expect(document.querySelector(".animate-pulse")?.textContent).toBe("Preparing your conversation");

  await act(async () => finishThread({ thread_id: "thread-1" }));
  expect(document.querySelector(".animate-pulse")?.textContent).toBe("Loading recent messages");
  expect(document.querySelectorAll(".animate-pulse")).toHaveLength(1);
  await act(async () => finishMessages({}));
});

it("does not restart boot prefetch after dismissal when the agent changes", async () => {
  vi.useFakeTimers();
  reads.profile.mockResolvedValue({});
  reads.agent.mockResolvedValue({});
  reads.thread.mockResolvedValue({ thread_id: "thread" });
  reads.messages.mockResolvedValue({});
  const onPickAgent = vi.fn();
  const { rerender, container } = render(
    <BootScreen agents={[]} agentsLoaded activeAgentId="first" onPickAgent={onPickAgent} onCreateAgent={vi.fn()} />,
  );
  expect(container.querySelector('[data-testid="boot-screen"]')?.getAttribute("role")).toBe("status");
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(750); });
  expect(container.innerHTML).toBe("");
  rerender(<BootScreen agents={[]} agentsLoaded activeAgentId="second" onPickAgent={onPickAgent} onCreateAgent={vi.fn()} />);
  await act(async () => {});
  expect(reads.agent).toHaveBeenCalledTimes(1);
  expect(reads.agent).toHaveBeenCalledWith("first", { startup: true });
  expect(reads.thread).toHaveBeenCalledTimes(1);
});
