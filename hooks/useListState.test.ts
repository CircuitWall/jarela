// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useListState } from "@/hooks/useListState";

describe("useListState", () => {
  it("loads initial items and exposes refresh", async () => {
    const loader = vi.fn<() => Promise<string[]>>().mockResolvedValue(["a", "b"]);

    const { result } = renderHook(() => useListState({ loader }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toEqual(["a", "b"]);

    loader.mockResolvedValueOnce(["x"]);
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.items).toEqual(["x"]);
  });

  it("uses eventLoader when event is dispatched", async () => {
    const loader = vi.fn<() => Promise<string[]>>().mockResolvedValue(["normal"]);
    const eventLoader = vi.fn<() => Promise<string[]>>().mockResolvedValue(["forced"]);

    const { result } = renderHook(() =>
      useListState({
        loader,
        eventName: "jarela:test-changed",
        eventLoader,
      }),
    );

    await waitFor(() => expect(result.current.items).toEqual(["normal"]));

    await act(async () => {
      window.dispatchEvent(new CustomEvent("jarela:test-changed"));
    });

    await waitFor(() => expect(result.current.items).toEqual(["forced"]));
    expect(eventLoader).toHaveBeenCalled();
  });

  it("surfaces errors and clears items", async () => {
    const loader = vi.fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(["ok"])
      .mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useListState({ loader }));

    await waitFor(() => expect(result.current.items).toEqual(["ok"]));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.items).toEqual([]);
    expect(result.current.error).toBe("boom");
  });
});
