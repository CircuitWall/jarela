// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentConfig, VersionAdoptionState } from "@/api/types";
import { BootScreen } from "./BootScreen";

const reads = vi.hoisted(() => ({
  profile: vi.fn(),
  agent: vi.fn(),
  thread: vi.fn(),
  messages: vi.fn(),
  metadata: vi.fn(),
  recentReplies: vi.fn().mockResolvedValue([]),
}));
const adoption = vi.hoisted(() => ({
  get: vi.fn(),
  action: vi.fn(),
  retryItem: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  api: {
    profile: { get: reads.profile },
    agents: { get: reads.agent, getThread: reads.thread, recentReplies: reads.recentReplies },
    threads: { get: reads.messages, metadata: reads.metadata },
    lifecycle: { adoption },
  },
}));
vi.mock("@/components/ui/Logo", () => ({ Logo: () => null }));
vi.mock("@/components/ui/VersionTag", () => ({ VersionTag: () => null }));
vi.mock("@/components/ui/PoweredBy", () => ({ PoweredBy: () => null }));
vi.mock("@/components/ui/WorkflowChecklist", () => ({
  WorkflowChecklist: ({ children }: { children?: ReactNode }) => children ?? null,
}));

const defaultAgent = {
  id: "agent-1",
  name: "Assistant",
  icon: null,
  identity: "helper",
  instructions: "Be useful.",
  tools: [],
  is_default: true,
} as AgentConfig;

function adoptionState(overrides: Partial<VersionAdoptionState> = {}): VersionAdoptionState {
  return {
    current_version: "2.0.0",
    previous_version: "1.0.0",
    is_first_adoption: false,
    status: "done",
    phase: "complete",
    default_agent_id: defaultAgent.id,
    default_agent_name: defaultAgent.name,
    adoption_thread_id: "adoption-thread",
    adoption_prompt: null,
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:01.000Z",
    dismissed_at: null,
    summary: "One adoption item remains.",
    checklist: [{
      id: "adapt-settings",
      label: "Adapt agent settings",
      input: "Release changes",
      output: "Updated settings",
      validation: "Re-read the agent",
      status: "needs_attention",
      reason: "Approval is pending.",
      affected_files: [],
    }],
    stale_prompt_risks: [],
    error: null,
    ...overrides,
  };
}

afterEach(() => { vi.useRealTimers(); });
beforeEach(() => {
  vi.clearAllMocks();
  adoption.get.mockReset().mockResolvedValue(null);
  adoption.action.mockReset();
  adoption.retryItem.mockReset();
});

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

  expect(reads.recentReplies).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Create an agent" }));
  expect(onCreateAgent).toHaveBeenCalledOnce();
});

it("shows a retry instead of the create tile when the agent list failed", () => {
  const onRetryAgents = vi.fn();
  render(
    <BootScreen
      agents={[]}
      agentsLoaded
      agentsError="HTTP 503"
      onRetryAgents={onRetryAgents}
      activeAgentId={null}
      onPickAgent={vi.fn()}
      onCreateAgent={vi.fn()}
    />,
  );

  expect(screen.getByRole("alert").textContent).toContain("Could not load agents: HTTP 503");
  expect(screen.getByText("Could not load your agents")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create an agent" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetryAgents).toHaveBeenCalledOnce();
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
  vi.useFakeTimers();
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
  expect(reads.messages).toHaveBeenCalledWith("thread-1", { startup: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(750); });
  expect(screen.queryByTestId("boot-screen")).toBeNull();
  // The startup handoff is complete while the transcript fetch is still
  // pending; ChatView shows its own message loader during this time.
  expect(reads.messages).toHaveBeenCalledOnce();
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

it("opens the adoption conversation instead of dismissing when a step needs the user", async () => {
  adoption.get.mockResolvedValue(adoptionState());
  reads.profile.mockResolvedValue({});
  reads.agent.mockResolvedValue({});
  reads.thread.mockResolvedValue({ thread_id: "thread" });
  reads.messages.mockResolvedValue({});
  const onPickAgent = vi.fn();
  render(
    <BootScreen
      agents={[defaultAgent]}
      agentsLoaded
      activeAgentId={null}
      onPickAgent={onPickAgent}
      onCreateAgent={vi.fn()}
    />,
  );

  const adapt = await screen.findByRole("button", { name: "Adapt" });
  expect(screen.getByText("Summary ready. Open the adaptation to review the actions that still need you.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();

  fireEvent.click(adapt);
  expect(onPickAgent).toHaveBeenCalledWith(defaultAgent.id, "adoption-thread");
  expect(adoption.action).not.toHaveBeenCalled();
});

it("offers adapt while a running adoption is waiting for the user", async () => {
  adoption.get.mockResolvedValue(adoptionState({
    status: "running",
    phase: "adoption",
    completed_at: null,
  }));
  reads.profile.mockResolvedValue({});
  reads.agent.mockResolvedValue({});
  reads.thread.mockResolvedValue({ thread_id: "thread" });
  reads.messages.mockResolvedValue({});
  const onPickAgent = vi.fn();
  render(
    <BootScreen
      agents={[defaultAgent]}
      agentsLoaded
      activeAgentId={null}
      onPickAgent={onPickAgent}
      onCreateAgent={vi.fn()}
    />,
  );

  expect(await screen.findByText("Running")).toBeTruthy();
  const adapt = await screen.findByRole("button", { name: "Adapt" });
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();

  fireEvent.click(adapt);
  expect(onPickAgent).toHaveBeenCalledWith(defaultAgent.id, "adoption-thread");
});

it("keeps dismiss when the adoption verdict needs no user action", async () => {
  const state = adoptionState({
    checklist: [{
      id: "adapt-settings",
      label: "Adapt agent settings",
      input: "Release changes",
      output: "Updated settings",
      validation: "Re-read the agent",
      status: "done",
      validation_evidence: "Agent settings were re-read.",
      reason: "Settings were checked.",
      affected_files: [],
    }],
  });
  adoption.get.mockResolvedValue(state);
  adoption.action.mockResolvedValue({ ...state, status: "dismissed" });
  render(
    <BootScreen
      agents={[defaultAgent]}
      agentsLoaded
      activeAgentId={null}
      onPickAgent={vi.fn()}
      onCreateAgent={vi.fn()}
    />,
  );

  const dismiss = await screen.findByRole("button", { name: "Dismiss" });
  expect(screen.getByText("Summary ready. No pending adoption actions were flagged.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Adapt" })).toBeNull();

  fireEvent.click(dismiss);
  await waitFor(() => expect(adoption.action).toHaveBeenCalledWith("dismiss"));
});
