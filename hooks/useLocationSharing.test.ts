// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocationSharing } from "@/hooks/useLocationSharing";

const updateLocationMock = vi.fn();
const clearLocationMock = vi.fn();
const getCurrentPositionMock = vi.fn();
const watchPositionMock = vi.fn();
const clearWatchMock = vi.fn();

vi.mock("@/api/client", () => ({
  api: {
    profile: {
      updateLocation: (...args: unknown[]) => updateLocationMock(...args),
      clearLocation: (...args: unknown[]) => clearLocationMock(...args),
    },
  },
}));

describe("useLocationSharing contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateLocationMock.mockResolvedValue({});
    clearLocationMock.mockResolvedValue({});
    getCurrentPositionMock.mockReset();
    watchPositionMock.mockReset();
    clearWatchMock.mockReset();

    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: getCurrentPositionMock,
        watchPosition: watchPositionMock,
        clearWatch: clearWatchMock,
      },
    });
  });

  it("exposes unified and compatibility surfaces and clears when consent is false", async () => {
    renderHook(() => useLocationSharing(false));

    await waitFor(() => expect(clearLocationMock).toHaveBeenCalled());
    const { result } = renderHook(() => useLocationSharing(false));
    expect(result.current.clearSharedLocation).toBe(result.current.commands.clearSharedLocation);
    expect(result.current.consent).toBe(result.current.state.consent);
  });

  it("posts geolocation when consent is true", async () => {
    getCurrentPositionMock.mockImplementation((success: (p: GeolocationPosition) => void) => {
      success({
        coords: {
          latitude: 1,
          longitude: 2,
          accuracy: 10,
        },
      } as GeolocationPosition);
    });
    watchPositionMock.mockReturnValue(42);

    const { result } = renderHook(() => useLocationSharing(true));

    await waitFor(() => expect(updateLocationMock).toHaveBeenCalled());
    expect(result.current.watching).toBe(result.current.state.watching);
    expect(result.current.lastError).toBeNull();
  });
});
