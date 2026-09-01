// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    eventSources.length = 0;
    pushToastMock.mockReset();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("refreshes updated activity rows and keeps silent failures visible", () => {
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    const updated = vi.fn();
    window.addEventListener("jarela:thread-updated", updated);
    const { unmount } = renderHook(() =>
      useEventNotifications({
        shouldNotify: () => true,
        resolveAgentName: () => "Agent",
      }),
    );
    const source = eventSources[0]!;

    act(() => {
      source.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({
          type: "automation_activity",
          thread_id: "t1",
          agent_id: "a1",
          ts: Date.now(),
        }),
      }));
    });
    expect((updated.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      thread_id: "t1",
      replace_existing: true,
    });
    expect(pushToastMock).not.toHaveBeenCalled();

    act(() => {
      source.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({
          type: "task_completed",
          task_id: "task-1",
          thread_id: "t1",
          agent_id: "a1",
          status: "error",
          preview: "",
          error: "boom",
          silent: true,
          ts: Date.now() + 1,
        }),
      }));
    });
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: "error",
      body: "boom",
    }));

    unmount();
    window.removeEventListener("jarela:thread-updated", updated);
  });
});
