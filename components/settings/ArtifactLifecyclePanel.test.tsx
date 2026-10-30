// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ArtifactLifecyclePanel } from "./ArtifactLifecyclePanel";

const mocks = vi.hoisted(() => ({
  lifecycle: vi.fn(),
  update: vi.fn(),
  cleanup: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("@/api/client", () => ({
  api: { artifacts: { lifecycle: mocks.lifecycle, updateLifecycle: mocks.update, cleanup: mocks.cleanup } },
}));
vi.mock("@/lib/ui/toasts", () => ({ pushToast: vi.fn() }));
vi.mock("@/lib/ui/error-report", () => ({ pushErrorToast: vi.fn() }));
vi.mock("@/lib/ui/confirm", () => ({ confirmAction: mocks.confirm }));

const settings = {
  retention_days: 30,
  max_total_mb: 256,
  include_browser_artifacts: true,
  include_generated_media: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lifecycle.mockResolvedValue({
    settings,
    inventory: { total_files: 0, total_bytes: 0, browser_bytes: 0, files: [] },
  });
  mocks.cleanup.mockResolvedValue({ result: { deleted_count: 2, deleted_bytes: 2048 } });
});

it("previews the persisted policy, confirms deletion, and refreshes only after cleanup", async () => {
  render(<ArtifactLifecyclePanel />);
  const retention = await screen.findByRole("spinbutton", { name: /Retention/ });
  fireEvent.change(retention, { target: { value: "60" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview cleanup" }));
  await screen.findByText(/Preview would delete 2 files/);
  expect(mocks.cleanup).toHaveBeenCalledWith({ dryRun: true });
  expect(mocks.update).not.toHaveBeenCalled();

  mocks.confirm.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "Clean now" }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  expect(mocks.cleanup).toHaveBeenCalledTimes(1);

  mocks.confirm.mockResolvedValueOnce(true);
  fireEvent.click(screen.getByRole("button", { name: "Clean now" }));
  await waitFor(() => expect(mocks.lifecycle).toHaveBeenCalledTimes(2));
  expect(mocks.cleanup).toHaveBeenLastCalledWith({ dryRun: false });
  expect(mocks.cleanup.mock.invocationCallOrder[1]).toBeLessThan(mocks.lifecycle.mock.invocationCallOrder[1]);
  expect(screen.queryByText(/Preview would delete/)).toBeNull();
});
