// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/api/types";
import { IDLE_COMPACTION_DELAY_MS, useIdleCompactionChoice } from "./useIdleCompactionChoice";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "latest",
    seq: 2,
    role: "assistant",
    content: "Answer",
    created_at: new Date(Date.now() - IDLE_COMPACTION_DELAY_MS).toISOString(),
    ...overrides,
  };
}

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("useIdleCompactionChoice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("opens exactly when the latest foreground message reaches three hours", async () => {
    const latestUser = message({ id: "user", seq: 4, role: "user", created_at: new Date(Date.now() - IDLE_COMPACTION_DELAY_MS).toISOString() });
    const latestAssistant = message({ id: "assistant", seq: 5, created_at: new Date(Date.now() - IDLE_COMPACTION_DELAY_MS + 1).toISOString() });
    const { result, rerender } = renderHook(
      ({ messages }) => useIdleCompactionChoice("thread-a", messages, true),
      { initialProps: { messages: [latestUser, latestAssistant] } },
    );

    await tick(0);
    expect(result.current.open).toBe(false);
    await tick(1);
    expect(result.current.open).toBe(true);
    expect(result.current.boundarySeq).toBe(4);

    rerender({ messages: [latestUser, latestAssistant, message({ id: "bridge", seq: 6, category: "bridge" })] });
    expect(result.current.open).toBe(true);

    rerender({
      messages: [
        latestUser,
        latestAssistant,
        message({
          id: "activity",
          seq: 7,
          metadata: {
            automation_activity: {
              version: 1,
              source_kind: "watcher",
              source_id: "watcher-1",
              label: "Background activity",
              state: "complete",
              occurrence_count: 1,
              first_at: latestAssistant.created_at,
              last_at: latestAssistant.created_at,
            },
          },
        }),
      ],
    });
    expect(result.current.open).toBe(true);
  });

  it("shows immediately when reopening a thread that is already idle", async () => {
    const oldUser = message({ id: "old-user", seq: 8, role: "user", created_at: new Date(Date.now() - IDLE_COMPACTION_DELAY_MS - 60_000).toISOString() });
    const oldAssistant = message({ id: "old-answer", seq: 9, created_at: oldUser.created_at });
    const { result } = renderHook(() => useIdleCompactionChoice("thread-a", [oldUser, oldAssistant], true));

    await tick(0);
    expect(result.current.open).toBe(true);
  });

  it("does not ask again when a fresh summary was computed after the latest message", async () => {
    const oldUser = message({ id: "old-user", seq: 8, role: "user", created_at: new Date(Date.now() - IDLE_COMPACTION_DELAY_MS - 60_000).toISOString() });
    const oldAssistant = message({ id: "old-answer", seq: 9, created_at: oldUser.created_at });
    const { result } = renderHook(() => useIdleCompactionChoice("thread-a", [oldUser, oldAssistant], true, {
      hotSinceSeq: 8,
      warmSummaryBeforeSeq: 8,
      warmSummaryComputedAt: new Date(Date.now() + 1).toISOString(),
    }));

    await tick(0);
    expect(result.current.open).toBe(false);
  });

  it("does not ask again when a fresh boundary already covers the idle cutoff", async () => {
    const oldUser = message({ id: "old-user", seq: 8, role: "user", created_at: new Date(Date.now() - IDLE_COMPACTION_DELAY_MS - 60_000).toISOString() });
    const oldAssistant = message({ id: "old-answer", seq: 9, created_at: oldUser.created_at });
    const { result } = renderHook(() => useIdleCompactionChoice("thread-a", [oldUser, oldAssistant], true, {
      hotSinceSeq: 9,
      warmSummaryBeforeSeq: 9,
      warmSummaryComputedAt: new Date(Date.parse(oldUser.created_at) - 60_000).toISOString(),
    }));

    await tick(0);
    expect(result.current.open).toBe(false);
  });

  it("resets the deadline on new foreground activity and resolves per message", async () => {
    const old = message();
    const { result, rerender } = renderHook(
      ({ messages }) => useIdleCompactionChoice("thread-a", messages, true),
      { initialProps: { messages: [message({ id: "user", seq: 1, role: "user" }), old] } },
    );
    await tick(0);
    expect(result.current.open).toBe(true);
    act(() => result.current.resolve());
    expect(result.current.open).toBe(false);

    const nextUser = message({
      id: "next-user",
      seq: 3,
      role: "user",
      created_at: new Date(Date.now()).toISOString(),
    });
    rerender({ messages: [old, nextUser] });
    await tick(0);
    expect(result.current.open).toBe(false);
    await tick(IDLE_COMPACTION_DELAY_MS);
    expect(result.current.open).toBe(true);
    expect(result.current.boundarySeq).toBe(3);
  });

  it("does not trigger without a persisted foreground user message or while disabled", async () => {
    const old = message({ created_at: new Date(Date.now() - IDLE_COMPACTION_DELAY_MS * 2).toISOString() });
    const { result, rerender } = renderHook(
      ({ messages, enabled }) => useIdleCompactionChoice("thread-a", messages, enabled),
      { initialProps: { messages: [old], enabled: true } },
    );
    await tick(0);
    expect(result.current.open).toBe(false);

    const oldUser = message({ id: "user", seq: 1, role: "user", created_at: old.created_at });
    rerender({ messages: [oldUser, old], enabled: false });
    await tick(IDLE_COMPACTION_DELAY_MS);
    expect(result.current.open).toBe(false);
  });
});
