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
