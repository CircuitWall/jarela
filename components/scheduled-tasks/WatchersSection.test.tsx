// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WatchersSection } from "./WatchersSection";

const mocks = vi.hoisted(() => ({ runNow: vi.fn(), refresh: vi.fn() }));
vi.mock("@/api/client", () => ({ api: { watchers: { runNow: mocks.runNow } } }));
vi.mock("@/lib/ui/toasts", () => ({ pushToast: vi.fn() }));
vi.mock("@/lib/ui/error-report", () => ({ pushErrorToast: vi.fn() }));
vi.mock("@/hooks/useListState", () => ({
  useListState: () => ({
    loading: false,
    refresh: mocks.refresh,
    items: [{
      id: "watcher-1",
      label: "Example watcher",
      tool: "example_read",
      args: {},
      interval_seconds: 60,
      enabled: true,
      reaction_kind: "agent_prompt",
      reaction_prompt: "Report changes",
      agent_id: "agent-1",
      next_run_at: "2030-01-01T00:00:00Z",
    }],
  }),
}));

it("retains in-flight control state when the watcher is collapsed and reopened", async () => {
  let finish!: () => void;
  mocks.runNow.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  render(<WatchersSection agents={{}} models={[]} />);
  const header = screen.getByRole("button", { name: /Example watcher/ });
  fireEvent.click(header);
  fireEvent.click(screen.getByRole("button", { name: "Poll now" }));
  expect(mocks.runNow).toHaveBeenCalledWith("watcher-1");

  fireEvent.click(header);
  fireEvent.click(header);
  expect((screen.getByRole("button", { name: "Polling…" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish());
  expect((screen.getByRole("button", { name: "Poll now" }) as HTMLButtonElement).disabled).toBe(false);
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
});
