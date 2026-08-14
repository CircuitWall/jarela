// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "@/contexts/AppContext";
import { useUrlSync } from "@/hooks/useUrlSync";

function wrapper({ children }: { children: ReactNode }) {
  return createElement(AppProvider, null, children);
}

describe("useUrlSync contract", () => {
  it("exposes unified commands and mirrors compatibility fields", () => {
    window.history.replaceState(null, "", "/?tab=extensions");
    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    const { result } = renderHook(() => useUrlSync(), { wrapper });

    expect(result.current.syncFromUrl).toBe(result.current.commands.syncFromUrl);
    expect(result.current.syncToUrl).toBe(result.current.commands.syncToUrl);
    expect(result.current.lastWrittenHref).toBe(result.current.state.lastWrittenHref);

    act(() => {
      result.current.commands.syncToUrl();
    });

    return waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalled();
      replaceStateSpy.mockRestore();
    });
  });
});
