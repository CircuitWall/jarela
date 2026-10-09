// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSSE } from "@/hooks/useSSE";

const submitRunMock = vi.fn();
const subscribeRunMock = vi.fn();
const abortRunMock = vi.fn();

const setActivityMock = vi.fn();
const clearActivityMock = vi.fn();

vi.mock("@/api/client", () => ({
  submitRun: (...args: unknown[]) => submitRunMock(...args),
  subscribeRun: (...args: unknown[]) => subscribeRunMock(...args),
  api: {
    threads: {
      abortRun: (...args: unknown[]) => abortRunMock(...args),
    },
  },
}));

vi.mock("@/lib/ui/loading", () => ({
  pushActivity: () => ({ set: setActivityMock, setInflightTools: () => {}, clear: clearActivityMock }),
}));

// Every test sets up its own mock behavior; without this, call counts and
// queued mockReturnValueOnce()s leak across tests sharing these module-level
// mocks, which silently corrupts assertions like toHaveBeenCalledTimes.
beforeEach(() => {
  vi.clearAllMocks();
});

function streamDone(): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      yield JSON.stringify({ type: "text_delta", delta: "hello" });
      yield JSON.stringify({ type: "done" });
    },
  };
}

function streamWithFabricationRetry(): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      yield JSON.stringify({ type: "text_delta", delta: "flagged reply" });
      yield JSON.stringify({ type: "reset_text" });
      yield JSON.stringify({ type: "text_delta", delta: "corrected reply" });
      yield JSON.stringify({ type: "done" });
    },
  };
}

function streamWithProgress(): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      yield JSON.stringify({ type: "tool_call", id: "c1", name: "claude_delegate", arguments: { task: "x" } });
      yield JSON.stringify({ type: "tool_progress", id: "c1", name: "claude_delegate", text: "Claude: looking at the code" });
      yield JSON.stringify({ type: "tool_result", id: "c1", name: "claude_delegate", result: { ok: true } });
      yield JSON.stringify({ type: "done" });
    },
  };
}

describe("useSSE contract", () => {
  it("exposes unified and compatibility surfaces", async () => {
    submitRunMock.mockResolvedValue({ accepted: true });
    subscribeRunMock.mockReturnValue(streamDone());

    const { result } = renderHook(() => useSSE());

    expect(result.current.start).toBe(result.current.commands.start);
    expect(result.current.streaming).toBe(result.current.state.streaming);
    expect(result.current.error).toBe(result.current.state.error);

    await act(async () => {
      const out = await result.current.commands.start("thread-1", "hello");
      expect(out.accepted).toBe(true);
    });

    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.streamingContent).toContain("hello");

    act(() => {
      result.current.commands.dismissAuthError();
      result.current.commands.clearStreamingContent();
    });

    expect(result.current.authError).toBeNull();
    expect(result.current.streamingContent).toBe("");
  });

  // Issue #576: a "reset_text" event (emitted when the output validator
  // flags a completed reply and auto-retries) must clear the streaming
  // buffer so the corrected retry replaces the flagged reply on screen
  // instead of appending after it.
  it("clears the streaming buffer on reset_text instead of appending", async () => {
    submitRunMock.mockResolvedValue({ accepted: true });
    subscribeRunMock.mockReturnValue(streamWithFabricationRetry());

    const { result } = renderHook(() => useSSE());

    await act(async () => {
      await result.current.commands.start("thread-1", "hello");
    });

    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.streamingContent).toBe("corrected reply");
    expect(result.current.streamingContent).not.toContain("flagged reply");
  });

  it("records tool_progress events alongside tool_call/tool_result (ADR-0073)", async () => {
    submitRunMock.mockResolvedValue({ accepted: true });
    subscribeRunMock.mockReturnValue(streamWithProgress());

    const { result } = renderHook(() => useSSE());

    await act(async () => {
      await result.current.commands.start("thread-1", "delegate this");
    });

    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.toolEvents).toEqual([
      { id: "c1", phase: "call", name: "claude_delegate", payload: { task: "x" } },
      { id: "c1", phase: "progress", name: "claude_delegate", payload: "Claude: looking at the code" },
      { id: "c1", phase: "result", name: "claude_delegate", payload: { ok: true } },
    ]);
  });

  // The tool trail must survive the gap between the stream's `done`/`error`
  // event and the consumer's refetch-driven clearToolEvents() call — same
  // protection streamingContent/thinkingContent already get (see the `done`
  // branch comment in useSSE.ts) — otherwise it flashes away before the
  // persisted message's own tool_events render.
  it("keeps toolEvents past streaming=false until clearToolEvents is called", async () => {
    submitRunMock.mockResolvedValue({ accepted: true });
    subscribeRunMock.mockReturnValue(streamWithProgress());

    const { result } = renderHook(() => useSSE());

    await act(async () => {
      await result.current.commands.start("thread-1", "delegate this");
    });

    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.toolEvents.length).toBeGreaterThan(0);

    act(() => {
      result.current.commands.clearToolEvents();
    });
    expect(result.current.toolEvents).toEqual([]);
  });
});

// ADR-0080 steering: the model keeps streaming into the SAME connection
// after a mid-run message (preModelHook drains it before the next model
// call) — a true stream break only happens in the rare edge case where
// steering lands during the final model call. Arming must not disrupt the
// live bubble on the mainline path, and must only freeze/reconnect at an
// actual `done` boundary.
describe("useSSE steering continuation (ADR-0080)", () => {
  it("armSteeredContinuation alone is a non-destructive ref update", () => {
    const { result } = renderHook(() => useSSE());

    act(() => {
      result.current.commands.armSteeredContinuation("steer-1");
    });

    expect(result.current.streamingContent).toBe("");
    expect(result.current.steeredSegments).toEqual([]);
  });

  // A stream that yields nothing until `release()` is called, so the test
  // can deterministically arm the ref — synchronously, between two plain
  // `act()` calls — before the mocked stream is allowed to produce its
  // first event. This sidesteps any ambiguity about microtask ordering
  // between `start()`'s internal awaits and the test's own statements.
  function gatedStream(events: Record<string, unknown>[]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return {
      iterable: {
        async *[Symbol.asyncIterator]() {
          await gate;
          for (const ev of events) yield JSON.stringify(ev);
        },
      },
      release: () => release(),
    };
  }

  it("keeps multiple deltas in one continuous buffer while armed, until the done boundary", async () => {
    submitRunMock.mockResolvedValue({ accepted: true });
    const first = gatedStream([
      { type: "text_delta", delta: "hello " },
      { type: "text_delta", delta: "world" },
      { type: "done" },
    ]);
    subscribeRunMock.mockReturnValueOnce(first.iterable);

    const { result } = renderHook(() => useSSE());

    let startPromise!: Promise<{ accepted: boolean }>;
    act(() => {
      startPromise = result.current.commands.start("thread-1", "hi");
    });
    act(() => {
      result.current.commands.armSteeredContinuation("steer-1");
    });

    await act(async () => {
      first.release();
      await startPromise;
    });

    await waitFor(() => expect(result.current.streaming).toBe(false));

    // The model kept writing into the same bubble across the steer — this
    // is the mainline (non-edge) case ADR-0080 describes. Both deltas landed
    // in one place; nothing was frozen/split until `done` actually fired.
    expect(result.current.steeredSegments).toEqual([{ id: "steer-1", content: "hello world" }]);
  });

  it("freezes the live content into a steeredSegment only at the done boundary, then reconnects", async () => {
    submitRunMock.mockResolvedValue({ accepted: true });
    const first = gatedStream([
      { type: "text_delta", delta: "prior live answer" },
      { type: "done" },
    ]);
    subscribeRunMock
      .mockReturnValueOnce(first.iterable)
      // Reconnect after the armed `done` — simulates the rare edge case
      // where undelivered steering triggers a genuine continuation turn.
      .mockReturnValueOnce({
        async *[Symbol.asyncIterator]() {
          yield JSON.stringify({ type: "text_delta", delta: "steered live answer" });
          yield JSON.stringify({ type: "done" });
        },
      });

    const { result } = renderHook(() => useSSE());

    let startPromise!: Promise<{ accepted: boolean }>;
    act(() => {
      startPromise = result.current.commands.start("thread-1", "hi");
    });
    act(() => {
      result.current.commands.armSteeredContinuation("steer-1");
    });

    await act(async () => {
      first.release();
      await startPromise;
    });

    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(subscribeRunMock).toHaveBeenCalledTimes(2);
    expect(result.current.steeredSegments).toEqual([{ id: "steer-1", content: "prior live answer" }]);
    expect(result.current.streamingContent).toBe("steered live answer");
  });

  it("rollbackSteeredSegment undoes a reactive split when the steer PATCH is rejected", async () => {
    submitRunMock.mockResolvedValue({ accepted: true });
    const first = gatedStream([
      { type: "text_delta", delta: "prior live answer" },
      { type: "done" },
    ]);
    subscribeRunMock
      .mockReturnValueOnce(first.iterable)
      // No real continuation was ever queued, so the reconnect this test
      // triggers resolves to the server's immediate synthetic `done`.
      .mockReturnValueOnce({
        async *[Symbol.asyncIterator]() {
          yield JSON.stringify({ type: "done" });
        },
      });

    const { result } = renderHook(() => useSSE());

    let startPromise!: Promise<{ accepted: boolean }>;
    act(() => {
      startPromise = result.current.commands.start("thread-1", "hi");
    });
    act(() => {
      result.current.commands.armSteeredContinuation("steer-1");
    });

    await act(async () => {
      first.release();
      await startPromise;
    });

    await waitFor(() => expect(result.current.steeredSegments.length).toBe(1));

    act(() => {
      result.current.commands.rollbackSteeredSegment("steer-1");
    });

    // The server never actually got this steer, so there is no continuation
    // to wait for — the frozen fragment is restored into the live bubble
    // exactly as it would have rendered without the steer attempt.
    expect(result.current.steeredSegments).toEqual([]);
    expect(result.current.streamingContent).toBe("prior live answer");
  });
});
