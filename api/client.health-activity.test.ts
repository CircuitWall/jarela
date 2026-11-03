// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { SERVER_ACTIVITY_EVENT } from "./health";

class TestEventSource {
  static CLOSED = 2;
  static latest: TestEventSource;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;

  constructor() {
    TestEventSource.latest = this;
  }

  close() {
    this.readyState = TestEventSource.CLOSED;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reports open and active run-stream responses as server activity", async () => {
  vi.stubGlobal("EventSource", TestEventSource);
  const { subscribeRun } = await import("./client");
  const activity = vi.fn();
  window.addEventListener(SERVER_ACTIVITY_EVENT, activity);
  const controller = new AbortController();
  const stream = subscribeRun("thread-a", controller.signal);
  const next = stream.next();
  const source = TestEventSource.latest;

  source.onopen?.(new Event("open"));
  expect(activity).toHaveBeenCalledOnce();

  const data = JSON.stringify({ type: "status", label: "working" });
  source.onmessage?.(new MessageEvent("message", { data }));
  await expect(next).resolves.toEqual({ value: data, done: false });
  expect(activity).toHaveBeenCalledTimes(2);

  controller.abort();
  await stream.next();
  window.removeEventListener(SERVER_ACTIVITY_EVENT, activity);
});
