// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { api } from "@/api/client";
import { useIntegrationOAuth } from "./useIntegrationOAuth";

describe("useIntegrationOAuth contract", () => {
  const onChanged = vi.fn();
  const onError = vi.fn();
  const onResult = vi.fn();
  const options = {
    integrationName: "gmail", credentialId: null, values: {},
    onChanged, onError, onResult,
  };
  const start = {
    authorize_url: "https://example.com/authorize", state: "synthetic-state",
    redirect_uri: "http://localhost/callback",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, "open").mockReturnValue(window);
    vi.spyOn(window, "close").mockImplementation(() => {});
    vi.spyOn(api.integrations, "gmailOauthStart").mockResolvedValue(start);
    vi.spyOn(api.integrations, "gmailOauthStatus").mockResolvedValue({ status: "done" });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("exposes canonical state/commands and matching flat fields through completion", async () => {
    const { result } = renderHook(() => useIntegrationOAuth(options));
    expect(result.current.state).toEqual({ connecting: false });
    expect(result.current.connecting).toBe(result.current.state.connecting);
    expect(result.current.connectOAuth).toBe(result.current.commands.connectOAuth);
    await act(async () => { await result.current.commands.connectOAuth("gmail"); });
    expect(result.current.state.connecting).toBe(true);
    expect(result.current.connecting).toBe(result.current.state.connecting);
    expect(onError).toHaveBeenCalledWith(null);
    expect(onResult).toHaveBeenCalledWith(null);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenLastCalledWith({ ok: true, message: "Connected to Gmail. Refresh token saved." });
    expect(result.current.state.connecting).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores duplicate connect commands before React can disable the button", async () => {
    const { result } = renderHook(() => useIntegrationOAuth(options));
    await act(async () => {
      await Promise.all([
        result.current.commands.connectOAuth("gmail"),
        result.current.commands.connectOAuth("gmail"),
      ]);
    });
    expect(api.integrations.gmailOauthStart).toHaveBeenCalledOnce();
    expect(window.open).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("allows retry after a start request fails", async () => {
    vi.mocked(api.integrations.gmailOauthStart).mockRejectedValueOnce(new Error("Synthetic start failure"));
    const { result } = renderHook(() => useIntegrationOAuth(options));
    await act(async () => { await result.current.commands.connectOAuth("gmail"); });
    expect(result.current.state.connecting).toBe(false);
    expect(onError).toHaveBeenLastCalledWith("Synthetic start failure");
    await act(async () => { await result.current.commands.connectOAuth("gmail"); });
    expect(result.current.state.connecting).toBe(true);
    expect(api.integrations.gmailOauthStart).toHaveBeenCalledTimes(2);
    expect(window.open).toHaveBeenCalledOnce();
  });
});
