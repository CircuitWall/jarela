// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useUserProfileAndAgent } from "./useUserProfileAndAgent";

const { getAgent, getProfile } = vi.hoisted(() => ({
  getAgent: vi.fn(),
  getProfile: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  api: { agents: { get: getAgent }, profile: { get: getProfile } },
}));

beforeEach(() => {
  vi.clearAllMocks();
  getProfile.mockResolvedValue({ name: "Test user" });
});

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

it("refreshes saved agent changes without dropping the current config or accepting a stale startup read", async () => {
  let resolveStartup!: (config: { id: string; voice_enabled: boolean }) => void;
  getAgent
    .mockImplementationOnce(() => new Promise((resolve) => { resolveStartup = resolve; }))
    .mockResolvedValueOnce({ id: "agent", voice_enabled: true })
    .mockResolvedValueOnce({ id: "agent", voice_enabled: false });
  const { result, unmount } = renderHook(() => useUserProfileAndAgent("agent"));
  act(() => { window.dispatchEvent(new Event("jarela:agents-changed")); });
  await waitFor(() => expect(result.current.agentConfig?.voice_enabled).toBe(true));
  expect(getAgent).toHaveBeenLastCalledWith("agent", undefined);
  await act(async () => resolveStartup({ id: "agent", voice_enabled: false }));
  expect(result.current.agentConfig?.voice_enabled).toBe(true);
  act(() => { window.dispatchEvent(new Event("jarela:agents-changed")); });
  expect(result.current.agentConfig?.voice_enabled).toBe(true);
  await waitFor(() => expect(result.current.agentConfig?.voice_enabled).toBe(false));
  expect(result.current.agentConfigLoading).toBe(false);
  unmount();
  act(() => { window.dispatchEvent(new Event("jarela:agents-changed")); });
  expect(getAgent).toHaveBeenCalledTimes(3);
});

it("ignores refreshes for the previous agent after a selection change", async () => {
  let finishOldRefresh!: (config: { id: string; voice_enabled: boolean }) => void;
  getAgent
    .mockResolvedValueOnce({ id: "old", voice_enabled: false })
    .mockImplementationOnce(() => new Promise((resolve) => { finishOldRefresh = resolve; }))
    .mockResolvedValueOnce({ id: "new", voice_enabled: false });
  const { result, rerender } = renderHook(({ id }) => useUserProfileAndAgent(id), { initialProps: { id: "old" } });
  await waitFor(() => expect(result.current.agentConfig?.id).toBe("old"));
  act(() => { window.dispatchEvent(new Event("jarela:agents-changed")); });
  rerender({ id: "new" });
  await waitFor(() => expect(result.current.agentConfig?.id).toBe("new"));
  await act(async () => finishOldRefresh({ id: "old", voice_enabled: true }));
  expect(result.current.agentConfig?.id).toBe("new");
  expect(result.current.agentConfig?.voice_enabled).toBe(false);
});
