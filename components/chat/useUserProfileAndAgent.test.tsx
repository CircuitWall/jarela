// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useUserProfileAndAgent } from "./useUserProfileAndAgent";

const { getAgent, getProfile } = vi.hoisted(() => ({
  getAgent: vi.fn(),
  getProfile: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  api: { agents: { get: getAgent }, profile: { get: getProfile } },
}));

it("warms startup reads and ignores an agent response after switching agents", async () => {
  let resolveOld!: (config: { id: string }) => void;
  getProfile.mockResolvedValue({ name: "Test user" });
  getAgent.mockImplementation((id: string) => id === "old"
    ? new Promise((resolve) => { resolveOld = resolve; })
    : Promise.resolve({ id }));
  const { result, rerender } = renderHook(
    ({ id }) => useUserProfileAndAgent(id),
    { initialProps: { id: "old" } },
  );
  rerender({ id: "new" });
  await waitFor(() => expect(result.current.agentConfig?.id).toBe("new"));
  await act(async () => resolveOld({ id: "old" }));
  expect(result.current.agentConfig?.id).toBe("new");
  expect(result.current.agentConfigLoading).toBe(false);
  expect(getProfile).toHaveBeenCalledWith({ startup: true });
  expect(getAgent).toHaveBeenCalledWith("new", { startup: true });
});
