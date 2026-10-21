// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReducedMotion } from "./useReducedMotion";

afterEach(() => vi.unstubAllGlobals());

it("tracks the reduced-motion preference when it changes", () => {
  let matches = false;
  const listeners = new Set<() => void>();
  const mediaQuery = {
    media: "(prefers-reduced-motion: reduce)",
    get matches() { return matches; },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));

  const { result, unmount } = renderHook(() => useReducedMotion());
  expect(result.current).toBe(false);

  act(() => {
    matches = true;
    listeners.forEach((listener) => listener());
  });
  expect(result.current).toBe(true);

  unmount();
  expect(listeners).toHaveLength(0);
});