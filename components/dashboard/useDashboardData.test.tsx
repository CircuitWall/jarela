// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboardData } from "./useDashboardData";

const apiMocks = vi.hoisted(() => ({
  metrics: vi.fn(),
  pricingTask: vi.fn(),
}));

vi.mock("@/api/client", () => ({
  api: { dashboard: { metrics: apiMocks.metrics, pricingTask: apiMocks.pricingTask } },
}));

describe("useDashboardData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.pricingTask.mockResolvedValue(null);
  });

  it("keeps the last metrics visible while a new date window loads", async () => {
    const previous = { generated_at: "previous" };
    let finishNext!: (value: typeof previous) => void;
    apiMocks.metrics
      .mockResolvedValueOnce(previous)
      .mockReturnValueOnce(new Promise((resolve) => { finishNext = resolve; }));

    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.data).toBe(previous));

    act(() => result.current.setDays(7));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBe(previous);

    await act(async () => finishNext({ generated_at: "updated" }));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ generated_at: "updated" });
  });
});
