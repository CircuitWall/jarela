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