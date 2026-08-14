// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageFilters } from "@/hooks/useMessageFilters";

const fetchMock = vi.fn();

describe("useMessageFilters contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  });

  it("exposes unified contract and keeps compatibility fields", async () => {
    const { result } = renderHook(() => useMessageFilters("agent-1"));

    expect(result.current.filters).toEqual(result.current.state.filters);
    expect(result.current.toggle).toBe(result.current.commands.toggle);
    expect(result.current.reset).toBe(result.current.commands.reset);

    await act(async () => {
      result.current.commands.toggle("thinking");
    });

    expect(result.current.state.filters.thinking).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/agents/agent-1/display-filters",
      expect.objectContaining({ method: "PUT" }),
    );
  });
});
