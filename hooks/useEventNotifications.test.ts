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

beforeEach(() => {
  eventSources.length = 0;
  pushToastMock.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("useEventNotifications routing", () => {
  it("uses the latest options without reconnecting and advances only supported replay events", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { result, rerender } = renderHook(({ name }) =>
      useEventNotifications({
        shouldNotify: () => true,
        resolveAgentName: () => name,
      }),
    { initialProps: { name: "Old" } });
    rerender({ name: "Current" });
    expect(eventSources).toHaveLength(1);
    const source = eventSources[0];
    act(() => {
      source.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({ type: "bridge_status", ts: 99 }),
      }));
    });
    expect(result.current.lastEventTs).toBe(99);
    expect(window.localStorage.getItem("jarela.notif.lastTs")).toBeNull();
    expect(pushToastMock).not.toHaveBeenCalled();

    act(() => {
      source.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({
          type: "run_completed", thread_id: "t1", agent_id: "a1",
          status: "done", preview: "Ready", ts: 100,
        }),
      }));
    });
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Current replied" }));
    expect(window.localStorage.getItem("jarela.notif.lastTs")).toBe("100");
  });

  it("refreshes extension activity without toasts and replaces health failures with recovery", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    renderHook(() => useEventNotifications({
      shouldNotify: () => false,
      resolveAgentName: () => "Agent",
    }));
    const source = eventSources[0];
    act(() => {
      source.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({
          type: "thread_message_added", thread_id: "t1", agent_id: "a1",
          source: "extension", ts: 100,
        }),
      }));
    });
    expect(pushToastMock).not.toHaveBeenCalled();
    for (const status of ["auth_failed", "recovered"]) {
      act(() => {
        source.onmessage?.(new MessageEvent("message", {
          data: JSON.stringify({
            type: "health_alert", category: "integration", label: "Example",
            probe: "example", status, error: null, ts: 101,
          }),
        }));
      });
    }
    expect(pushToastMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "error", ttl: 0, dedupeKey: "health:integration:Example",
    }));
    expect(pushToastMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: "success", ttl: 6000, dedupeKey: "health:integration:Example",
    }));
  });
});
