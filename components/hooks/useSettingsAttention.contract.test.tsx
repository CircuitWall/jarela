// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsAttention } from "@/hooks/useSettingsAttention";

const modelsListMock = vi.fn();
const integrationsListMock = vi.fn();

vi.mock("@/api/client", () => ({
  api: {
    models: {
      list: (...args: unknown[]) => modelsListMock(...args),
    },
    integrations: {
      list: (...args: unknown[]) => integrationsListMock(...args),
    },
  },
}));

describe("useSettingsAttention contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes unified state and refresh command", async () => {
    modelsListMock.mockResolvedValue([]);
    integrationsListMock.mockResolvedValue({ statuses: [{ configured: false }] });

    const { result } = renderHook(() => useSettingsAttention());

    await waitFor(() => expect(result.current.state.any).toBe(true));
    expect(result.current.any).toBe(true);
    expect(result.current.refresh).toBe(result.current.commands.refresh);

    modelsListMock.mockResolvedValueOnce([{ name: "m1" }]);
    integrationsListMock.mockResolvedValueOnce({ statuses: [{ configured: true }] });

    await act(async () => {
      await result.current.commands.refresh();
    });

    expect(result.current.state.any).toBe(false);
    expect(result.current.models).toBe(false);
    expect(result.current.credentials).toBe(false);
  });
});
