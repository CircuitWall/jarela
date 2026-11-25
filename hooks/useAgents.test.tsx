// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/api/client", () => ({
  api: { agents: { list: (...args: unknown[]) => mocks.list(...args) } },
}));

const { useAgents } = await import("./useAgents");

it("starts in a loading state until the initial agent list resolves", async () => {
  let resolveAgents!: (agents: never[]) => void;
  mocks.list.mockReturnValue(new Promise((resolve) => { resolveAgents = resolve; }));

  const { result } = renderHook(() => useAgents());
  expect(result.current.loading).toBe(true);
  expect(result.current.agents).toEqual([]);

  await act(async () => resolveAgents([]));
  await waitFor(() => expect(result.current.loading).toBe(false));
});

it("retries a transient initial failure with a cache-busted request", async () => {
  mocks.list
    .mockRejectedValueOnce(new Error("503 Service Unavailable"))
    .mockResolvedValueOnce([{ id: "agent-1", name: "Agent one" }]);

  const { result } = renderHook(() => useAgents());
  await waitFor(() => expect(result.current.agents).toHaveLength(1), { timeout: 3_000 });
  expect(mocks.list).toHaveBeenLastCalledWith({ force: true, cacheBust: true });
});

it("probes once past a stale empty response and adopts the recovered list", async () => {
  mocks.list
    .mockResolvedValueOnce([])
    .mockResolvedValue([{ id: "agent-1", name: "Agent one" }]);

  const { result } = renderHook(() => useAgents());
  await waitFor(() => expect(result.current.agents).toHaveLength(1));
  expect(mocks.list).toHaveBeenCalledWith({ force: true, cacheBust: true });
});