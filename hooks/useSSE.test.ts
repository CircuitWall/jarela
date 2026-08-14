// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  pushActivity: () => ({ set: setActivityMock, clear: clearActivityMock }),
}));

function streamDone(): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      yield JSON.stringify({ type: "text_delta", delta: "hello" });
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
});
