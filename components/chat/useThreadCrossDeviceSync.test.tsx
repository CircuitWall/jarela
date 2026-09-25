// @vitest-environment jsdom

import { useRef, useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/api/types";
import { useThreadCrossDeviceSync } from "./useThreadCrossDeviceSync";

const getThreadMock = vi.fn();

vi.mock("@/api/client", () => ({
  api: {
    threads: {
      get: (...args: unknown[]) => getThreadMock(...args),
    },
  },
}));

const initial: Message = {
  id: "activity-1",
  seq: 1,
  role: "assistant",
  content: "Check: checking",
  created_at: "2026-09-01T10:00:00.000Z",
  category: "watcher",
};

describe("useThreadCrossDeviceSync", () => {
  beforeEach(() => {
    getThreadMock.mockReset();
  });

  it("replaces loaded rows when an activity update mutates existing metadata", async () => {
    const updated: Message = {
      ...initial,
      content: "Check: no action needed",
      metadata: {
        automation_activity: {
          version: 1,
          source_kind: "watcher",
          source_id: "watcher-1",
          label: "Check",
          state: "complete",
          disposition: "no_action",
          occurrence_count: 1,
          first_at: initial.created_at,
          last_at: "2026-09-01T10:01:00.000Z",
        },
      },
    };
    getThreadMock.mockResolvedValue({
      messages: [updated],
      has_more: false,
    });

    const { result } = renderHook(() => {
      const [messages, setMessages] = useState<Message[]>([initial]);
      const messagesRef = useRef(messages);
      messagesRef.current = messages;
      useThreadCrossDeviceSync({
        threadId: "thread-1",
        streamingRef: { current: false },
        messagesRef,
        setMessages,
        setHasMore: vi.fn(),
        applyMeta: {
          setHotSince: vi.fn(),
          setWarmSummary: vi.fn(),
          setWarmSummaryBefore: vi.fn(),
          setWarmSummaryComputedAt: vi.fn(),
          setWarmSummarySourceMessages: vi.fn(),
          setWarmSummarySourceChars: vi.fn(),
          setContextWindowTokens: vi.fn(),
        },
      });
      return messages;
    });

    act(() => {
      window.dispatchEvent(new CustomEvent("jarela:thread-updated", {
        detail: {
          thread_id: "thread-1",
          replace_existing: true,
        },
      }));
    });

    await waitFor(() => {
      expect(result.current[0].content).toBe("Check: no action needed");
    });
    expect(getThreadMock).toHaveBeenCalledWith("thread-1", { limit: 50 });
  });

  it("merges instead of overwriting when the only local message is still unconfirmed", async () => {
    // Regression: a pending (not-yet-persisted) local bubble has no `seq`
    // yet, so it can't be used as the forward-fetch anchor. Before the fix
    // this fell through to the "no anchor" branch, which did a raw
    // `setMessages(() => d.messages)` overwrite and silently dropped the
    // pending bubble.
    const pending: Message = {
      id: "opt-1",
      role: "user",
      content: "still sending",
      created_at: "2026-09-01T10:05:00.000Z",
      status: "pending",
    };
    const serverRow: Message = {
      id: "s-1",
      seq: 2,
      role: "assistant",
      content: "unrelated cross-device update",
      created_at: "2026-09-01T10:04:00.000Z",
      category: "watcher",
    };
    getThreadMock.mockResolvedValue({ messages: [serverRow], has_more: false });

    const { result } = renderHook(() => {
      const [messages, setMessages] = useState<Message[]>([pending]);
      const messagesRef = useRef(messages);
      messagesRef.current = messages;
      useThreadCrossDeviceSync({
        threadId: "thread-1",
        streamingRef: { current: false },
        messagesRef,
        setMessages,
        setHasMore: vi.fn(),
        applyMeta: {
          setHotSince: vi.fn(),
          setWarmSummary: vi.fn(),
          setWarmSummaryBefore: vi.fn(),
          setWarmSummaryComputedAt: vi.fn(),
          setWarmSummarySourceMessages: vi.fn(),
          setWarmSummarySourceChars: vi.fn(),
          setContextWindowTokens: vi.fn(),
        },
      });
      return messages;
    });

    act(() => {
      window.dispatchEvent(new CustomEvent("jarela:thread-updated", {
        detail: { thread_id: "thread-1" },
      }));
    });

    await waitFor(() => {
      expect(result.current.map((m) => m.id)).toEqual(["s-1", "opt-1"]);
    });
    expect(result.current.find((m) => m.id === "opt-1")?.status).toBe("pending");
  });

  it("ignores an older refresh that resolves after a newer one", async () => {
    let resolveFirst!: (value: { messages: Message[]; has_more: boolean }) => void;
    let resolveSecond!: (value: { messages: Message[]; has_more: boolean }) => void;
    getThreadMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));

    const { result } = renderHook(() => {
      const [messages, setMessages] = useState<Message[]>([initial]);
      const messagesRef = useRef(messages);
      messagesRef.current = messages;
      useThreadCrossDeviceSync({
        threadId: "thread-1",
        streamingRef: { current: false },
        messagesRef,
        setMessages,
        setHasMore: vi.fn(),
        applyMeta: {
          setHotSince: vi.fn(),
          setWarmSummary: vi.fn(),
          setWarmSummaryBefore: vi.fn(),
          setWarmSummaryComputedAt: vi.fn(),
          setWarmSummarySourceMessages: vi.fn(),
          setWarmSummarySourceChars: vi.fn(),
          setContextWindowTokens: vi.fn(),
        },
      });
      return messages;
    });

    const refresh = () => window.dispatchEvent(new CustomEvent("jarela:thread-updated", {
      detail: { thread_id: "thread-1", replace_existing: true },
    }));
    act(() => {
      refresh();
      refresh();
    });

    const newest = { ...initial, content: "Check: no action needed" };
    const stale = { ...initial, content: "Check: queued" };
    await act(async () => {
      resolveSecond({ messages: [newest], has_more: false });
    });
    await waitFor(() => expect(result.current[0].content).toBe(newest.content));
    await act(async () => {
      resolveFirst({ messages: [stale], has_more: false });
    });
    expect(result.current[0].content).toBe(newest.content);
  });

  it("preserves a replacement when a later append resolves first", async () => {
    let resolveReplacement!: (value: { messages: Message[]; has_more: boolean }) => void;
    let resolveAppend!: (value: { messages: Message[]; has_more: boolean }) => void;
    getThreadMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveReplacement = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveAppend = resolve; }));

    const { result } = renderHook(() => {
      const [messages, setMessages] = useState<Message[]>([initial]);
      const messagesRef = useRef(messages);
      messagesRef.current = messages;
      useThreadCrossDeviceSync({
        threadId: "thread-1",
        streamingRef: { current: false },
        messagesRef,
        setMessages,
        setHasMore: vi.fn(),
        applyMeta: {
          setHotSince: vi.fn(),
          setWarmSummary: vi.fn(),
          setWarmSummaryBefore: vi.fn(),
          setWarmSummaryComputedAt: vi.fn(),
          setWarmSummarySourceMessages: vi.fn(),
          setWarmSummarySourceChars: vi.fn(),
          setContextWindowTokens: vi.fn(),
        },
      });
      return messages;
    });

    act(() => {
      window.dispatchEvent(new CustomEvent("jarela:thread-updated", {
        detail: { thread_id: "thread-1", replace_existing: true },
      }));
      window.dispatchEvent(new CustomEvent("jarela:thread-updated", {
        detail: { thread_id: "thread-1" },
      }));
    });

    const appended: Message = {
      id: "bridge-1",
      seq: 2,
      role: "user",
      content: "Remote reply",
      created_at: "2026-09-01T10:02:00.000Z",
    };
    await act(async () => {
      resolveAppend({ messages: [appended], has_more: false });
    });
    expect(result.current).toEqual([initial]);

    const updated: Message = {
      ...initial,
      content: "Check: no action needed",
      metadata: {
        automation_activity: {
          version: 1,
          source_kind: "watcher",
          source_id: "watcher-1",
          label: "Check",
          state: "complete",
          disposition: "no_action",
          occurrence_count: 1,
          first_at: initial.created_at,
          last_at: "2026-09-01T10:01:00.000Z",
        },
      },
    };
    await act(async () => {
      resolveReplacement({ messages: [updated], has_more: false });
    });

    await waitFor(() => expect(result.current.map((message) => message.id)).toEqual([
      updated.id,
      appended.id,
    ]));
    expect(result.current[0].metadata?.automation_activity?.state).toBe("complete");
  });
});
