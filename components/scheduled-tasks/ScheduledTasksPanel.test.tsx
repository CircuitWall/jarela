// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ScheduledTasksPanel } from "./ScheduledTasksPanel";

const mocks = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
vi.mock("@/hooks/useDeepLinkScroll", () => ({ useDeepLinkScroll: vi.fn() }));
vi.mock("./WatchersSection", () => ({ WatchersSection: () => null }));
vi.mock("@/lib/ui/error-report", () => ({ pushErrorToast: vi.fn() }));
vi.mock("@/api/client", () => ({
  api: {
    scheduledTasks: { list: mocks.list, update: mocks.update },
    agents: { list: async () => [] },
    models: { list: async () => [] },
  },
}));

it("keeps validation local and preserves the scheduled task update contract", async () => {
  mocks.list.mockResolvedValue([{
    id: "task-1",
    agent_id: "agent-1",
    prompt: "Original prompt",
    description: null,
    kind: "cron",
    schedule: "0 9 * * *",
    enabled: true,
    silent: false,
    reaction_kind: "script",
    next_run_at: "2030-01-01T00:00:00Z",
  }]);
  render(<ScheduledTasksPanel />);
  fireEvent.click(await screen.findByText("Original prompt"));
  fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
  const prompt = screen.getByDisplayValue("Original prompt");
  fireEvent.change(prompt, { target: { value: "  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  expect(screen.getByText("Prompt cannot be empty.")).toBeTruthy();
  expect(mocks.update).not.toHaveBeenCalled();

  fireEvent.change(prompt, { target: { value: " Updated prompt " } });
  fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("task-1", {
    agent_id: "agent-1",
    prompt: "Updated prompt",
    description: null,
    kind: "cron",
    schedule: "0 9 * * *",
    enabled: true,
    silent: false,
  }));
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
});
