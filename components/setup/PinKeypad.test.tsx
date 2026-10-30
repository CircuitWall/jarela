// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinKeypad } from "./PinKeypad";

vi.mock("@/components/ui/Logo", () => ({ Logo: () => <span>Logo</span> }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function enterPin() {
  for (const key of ["1", "2", "3", "4", "5", "6"]) {
    fireEvent.keyDown(window, { key });
  }
}

describe("PIN entry lifecycle", () => {
  it("submits once under StrictMode and converges on an already unlocked response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "not-locked" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSuccess = vi.fn();
    render(<StrictMode><PinKeypad mode="decrypt" onSuccess={onSuccess} /></StrictMode>);

    enterPin();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/security/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "123456" }),
    });
  });

  it("blocks keyboard submissions during cooldown and clears its timer on unmount", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ retry_after_ms: 1500 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<PinKeypad mode="unlock" onSuccess={vi.fn()} />);
    await act(async () => enterPin());
    expect(screen.getByRole("status").textContent).toBe("Try again in 2s");
    enterPin();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(2000));
    await act(async () => enterPin());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
