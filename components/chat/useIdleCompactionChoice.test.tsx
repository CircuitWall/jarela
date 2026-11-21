// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/api/types";
import { IDLE_COMPACTION_DELAY_MS, IDLE_COMPACTION_MIN_HOT_MESSAGES, useIdleCompactionChoice } from "./useIdleCompactionChoice";

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

// Filler foreground rows so a thread carries a hot window above the prompt
// threshold while the meaningful rows keep their own seq numbers.
function history(count: number, createdAt: string, startSeq = 1): Message[] {
  return Array.from({ length: count }, (_, index) => message({
    id: `history-${startSeq + index}`,
    seq: startSeq + index,
    role: index % 2 === 0 ? "user" : "assistant",
    created_at: createdAt,
  }));
}

function answers(count: number, createdAt: string, startSeq: number): Message[] {
  return Array.from({ length: count }, (_, index) => message({
    id: `answer-${startSeq + index}`,
    seq: startSeq + index,
    created_at: createdAt,
  }));
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
    const older = new Date(Date.now() - IDLE_COMPACTION_DELAY_MS * 2).toISOString();
    const latestUser = message({ id: "user", seq: 9, role: "user", created_at: new Date(Date.now() - IDLE_COMPACTION_DELAY_MS).toISOString() });
    const latestAssistant = message({ id: "assistant", seq: 10, created_at: new Date(Date.now() - IDLE_COMPACTION_DELAY_MS + 1).toISOString() });
    const { result, rerender } = renderHook(
      ({ messages }) => useIdleCompactionChoice("thread-a", messages, true),
      { initialProps: { messages: [...history(8, older), latestUser, latestAssistant] } },
    );

    await tick(0);
    expect(result.current.open).toBe(false);
    await tick(1);
    expect(result.current.open).toBe(true);
    expect(result.current.boundarySeq).toBe(9);

    rerender({ messages: [...history(8, older), latestUser, latestAssistant, message({ id: "bridge", seq: 11, category: "bridge" })] });
    expect(result.current.open).toBe(true);

    rerender({
      messages: [
        ...history(8, older),
        latestUser,
        latestAssistant,
        message({
          id: "activity",
          seq: 12,
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
    const oldAt = new Date(Date.now() - IDLE_COMPACTION_DELAY_MS - 60_000).toISOString();
    const oldUser = message({ id: "old-user", seq: 9, role: "user", created_at: oldAt });
    const oldAssistant = message({ id: "old-answer", seq: 10, created_at: oldAt });
    const { result } = renderHook(() => useIdleCompactionChoice("thread-a", [...history(8, oldAt), oldUser, oldAssistant], true));

    await tick(0);
    expect(result.current.open).toBe(true);
  });

  it("skips the prompt while the hot window holds fewer than the minimum", async () => {
    const oldAt = new Date(Date.now() - IDLE_COMPACTION_DELAY_MS - 60_000).toISOString();
    const short = [...history(8, oldAt),
      message({ id: "short-user", seq: 9, role: "user", created_at: oldAt })];
    const { result, rerender } = renderHook(
      ({ messages }) => useIdleCompactionChoice("thread-a", messages, true),
      { initialProps: { messages: short } },
    );

    expect(IDLE_COMPACTION_MIN_HOT_MESSAGES).toBe(10);
    await tick(0);
    expect(result.current.hotMessageCount).toBe(9);
    expect(result.current.open).toBe(false);

    rerender({ messages: [...short, message({ id: "short-answer", seq: 10, created_at: oldAt })] });
    await tick(0);
    expect(result.current.hotMessageCount).toBe(10);
    expect(result.current.open).toBe(true);
  });

  it("counts only messages at or after the pinned hot boundary", async () => {
    const oldAt = new Date(Date.now() - IDLE_COMPACTION_DELAY_MS - 60_000).toISOString();
    const messages = history(12, oldAt);
    const { result } = renderHook(() => useIdleCompactionChoice("thread-a", messages, true, { hotSinceSeq: 4 }));

    await tick(0);
    expect(result.current.hotMessageCount).toBe(9);
    expect(result.current.open).toBe(false);
  });

  it("does not ask again when a fresh summary was computed after the latest message", async () => {
    const oldAt = new Date(Date.now() - IDLE_COMPACTION_DELAY_MS - 60_000).toISOString();
    const oldUser = message({ id: "old-user", seq: 11, role: "user", created_at: oldAt });
    const oldAssistant = message({ id: "old-answer", seq: 12, created_at: oldAt });
    const { result } = renderHook(() => useIdleCompactionChoice("thread-a", [...history(10, oldAt), oldUser, oldAssistant], true, {
      hotSinceSeq: 1,
      warmSummaryBeforeSeq: 1,
      warmSummaryComputedAt: new Date(Date.now() + 1).toISOString(),
    }));

    await tick(0);
    expect(result.current.hotMessageCount).toBe(12);
    expect(result.current.open).toBe(false);
  });

  it("does not ask again when a fresh boundary already covers the idle cutoff", async () => {
    const oldAt = new Date(Date.now() - IDLE_COMPACTION_DELAY_MS - 60_000).toISOString();
    const oldUser = message({ id: "old-user", seq: 2, role: "user", created_at: oldAt });
    const followUps = answers(10, oldAt, 3);
    const { result } = renderHook(() => useIdleCompactionChoice("thread-a", [message({ id: "seed", seq: 1, role: "user", created_at: oldAt }), oldUser, ...followUps], true, {
      hotSinceSeq: 2,
      warmSummaryBeforeSeq: 2,
      warmSummaryComputedAt: new Date(Date.parse(oldAt) - 60_000).toISOString(),
    }));

    await tick(0);
    expect(result.current.hotMessageCount).toBe(11);
    expect(result.current.open).toBe(false);
  });

  it.each([
    {
      name: "boundary equals the latest user message",
      hotOffset: 0,
      summaryFresh: true,
      computedAtOffset: -60_000,
      shouldOpen: false,
    },
    {
      name: "boundary is at the latest assistant message",
      hotOffset: 1,
      summaryFresh: true,
      computedAtOffset: -60_000,
      shouldOpen: false,
    },
    {
      name: "boundary is earlier and summary was computed at the activity time",
      hotOffset: -1,
      summaryFresh: true,
      computedAtOffset: 0,
      shouldOpen: false,
    },
    {
      name: "boundary is earlier and summary predates the activity",
      hotOffset: -1,
      summaryFresh: true,
      computedAtOffset: -1,
      shouldOpen: true,
    },
    {
      name: "summary is stale even though its pin covers the candidate",
      hotOffset: 1,
      summaryFresh: false,
      computedAtOffset: 60_000,
      shouldOpen: true,
    },
    {
      name: "summary timestamp is invalid and boundary is earlier",
      hotOffset: -1,
      summaryFresh: true,
      computedAtOffset: Number.NaN,
      shouldOpen: true,
    },
    {
      name: "there is no persisted hot boundary",
      hotOffset: null,
      summaryFresh: false,
      computedAtOffset: 60_000,
      shouldOpen: true,
    },
  ])("handles $name", async ({ hotOffset, summaryFresh, computedAtOffset, shouldOpen }) => {
    const activityAt = Date.now() - IDLE_COMPACTION_DELAY_MS - 60_000;
    const activityIso = new Date(activityAt).toISOString();
    const oldUser = message({ id: "old-user", seq: 2, role: "user", created_at: activityIso });
    const oldAssistant = message({ id: "old-answer", seq: 13, created_at: activityIso });
    const thread = [
      message({ id: "seed", seq: 1, role: "user", created_at: activityIso }),
      oldUser,
      ...answers(10, activityIso, 3),
      oldAssistant,
    ];
    const hotSinceSeq = hotOffset === null ? null : oldUser.seq! + hotOffset;
    const { result } = renderHook(() => useIdleCompactionChoice("thread-a", thread, true, {
      hotSinceSeq,
      warmSummaryBeforeSeq: summaryFresh ? hotSinceSeq : (hotSinceSeq == null ? null : hotSinceSeq - 1),
      warmSummaryComputedAt: Number.isNaN(computedAtOffset)
        ? "not-a-date"
        : new Date(activityAt + computedAtOffset).toISOString(),
    }));

    await tick(0);
    expect(result.current.hotMessageCount).toBeGreaterThanOrEqual(IDLE_COMPACTION_MIN_HOT_MESSAGES);
    expect(result.current.open).toBe(shouldOpen);
  });

  it("reopens for a newer message after the compacted boundary when that message reaches three hours", async () => {
    const previousActivityAt = Date.now() - IDLE_COMPACTION_DELAY_MS - 60_000;
    const previousActivityIso = new Date(previousActivityAt).toISOString();
    const oldUser = message({ id: "old-user", seq: 8, role: "user", created_at: previousActivityIso });
    const oldAssistant = message({ id: "old-answer", seq: 9, created_at: previousActivityIso });
    const compactionState = {
      hotSinceSeq: 9,
      warmSummaryBeforeSeq: 9,
      warmSummaryComputedAt: new Date(previousActivityAt + 1).toISOString(),
    };
    const { result, rerender } = renderHook(
      ({ messages }) => useIdleCompactionChoice("thread-a", messages, true, compactionState),
      { initialProps: { messages: [...history(7, previousActivityIso), oldUser, oldAssistant] } },
    );

    await tick(0);
    expect(result.current.open).toBe(false);

    const nextUser = message({
      id: "next-user",
      seq: 10,
      role: "user",
      created_at: new Date(Date.now()).toISOString(),
    });
    rerender({ messages: [...history(7, previousActivityIso), oldUser, oldAssistant, nextUser, ...history(9, nextUser.created_at, 11)] });
    await tick(0);
    expect(result.current.hotMessageCount).toBe(11);
    expect(result.current.open).toBe(false);
    await tick(IDLE_COMPACTION_DELAY_MS - 1);
    expect(result.current.open).toBe(false);
    await tick(1);
    expect(result.current.open).toBe(true);
    expect(result.current.boundarySeq).toBe(19);
  });

  it("resets the deadline on new foreground activity and resolves per message", async () => {
    const older = new Date(Date.now() - IDLE_COMPACTION_DELAY_MS * 2).toISOString();
    const atCutoff = new Date(Date.now() - IDLE_COMPACTION_DELAY_MS).toISOString();
    const backlog = [...history(8, older), message({ id: "user", seq: 9, role: "user", created_at: older })];
    const old = message({ id: "latest", seq: 10, created_at: atCutoff });
    const { result, rerender } = renderHook(
      ({ messages }) => useIdleCompactionChoice("thread-a", messages, true),
      { initialProps: { messages: [...backlog, old] } },
    );
    await tick(0);
    expect(result.current.open).toBe(true);
    act(() => result.current.resolve());
    expect(result.current.open).toBe(false);

    const nextUser = message({
      id: "next-user",
      seq: 11,
      role: "user",
      created_at: new Date(Date.now()).toISOString(),
    });
    rerender({ messages: [...backlog, old, nextUser] });
    await tick(0);
    expect(result.current.open).toBe(false);
    await tick(IDLE_COMPACTION_DELAY_MS);
    expect(result.current.open).toBe(true);
    expect(result.current.boundarySeq).toBe(11);
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
