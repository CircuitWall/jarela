// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEventNotifications } from "@/hooks/useEventNotifications";

const pushToastMock = vi.fn();
const eventSources: FakeEventSource[] = [];

vi.mock("@/lib/ui/toasts", () => ({
  pushToast: (...args: unknown[]) => pushToastMock(...args),
}));

class FakeEventSource {
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;

  constructor(public readonly url: string) {
    eventSources.push(this);
  }

  close() {}
}

describe("useEventNotifications contract", () => {
  it("exposes unified contract and reconnect command", async () => {
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);

    const { result } = renderHook(() =>
      useEventNotifications({
        shouldNotify: () => false,
        resolveAgentName: () => "Agent",
      }),
    );

    expect(result.current.reconnectNow).toBe(result.current.commands.reconnectNow);
    expect(result.current.connected).toBe(result.current.state.connected);

    act(() => {
      eventSources[0]?.onopen?.(new Event("open"));
      eventSources[0]?.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "run_completed",
            thread_id: "t1",
            agent_id: "a1",
            status: "done",
            preview: "ok",
            ts: 123,
          }),
        }),
      );
    });

    await waitFor(() => expect(result.current.state.connected).toBe(true));
    expect(result.current.state.lastEventTs).toBe(123);
    expect(pushToastMock).not.toHaveBeenCalled();

    act(() => {
      result.current.commands.reconnectNow();
    });

    await waitFor(() => expect(eventSources.length).toBeGreaterThan(1));
  });
});
