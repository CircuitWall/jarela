import { describe, it, expect } from "vitest";
import type { Message } from "@/api/types";
import { appendUnique, applyThreadMeta, type ThreadMetaApplier } from "./chat-helpers";

// created_at is display-only after the seq-ordering change — every fixture
// shares one value to prove ordering doesn't depend on it. `seq` is omitted
// for optimistic/pending bubbles: the server hasn't assigned one yet.
const SAME_TIMESTAMP = "2026-08-01T10:00:00.000Z";
const mkMsg = (id: string, role: "user" | "assistant", content: string, seq?: number, status?: "pending" | "sent" | "steering" | "confirmed"): Message => ({
  id,
  role,
  content,
  created_at: SAME_TIMESTAMP,
  ...(typeof seq === "number" ? { seq } : {}),
  ...(status ? { status } : {}),
});

describe("appendUnique — ordering", () => {
  it("promotes a pending user bubble in place when the server row arrives", () => {
    const prev: Message[] = [
      mkMsg("s1", "user", "hello", 1, "confirmed"),
      mkMsg("opt-1", "user", "world", undefined, "pending"),
    ];
    const incoming: Message[] = [
      mkMsg("s2", "user", "world", 2),
    ];
    const out = appendUnique(prev, incoming);
    expect(out.map((m) => m.id)).toEqual(["s1", "s2"]);
    expect(out[1].status).toBe("confirmed");
  });

  // Every unconfirmed state reconciles in place. If one were missed the
  // server row would append alongside it and the bubble would appear twice.
  it.each(["pending", "sent", "steering"] as const)(
    "promotes a %s bubble in place rather than duplicating it",
    (status) => {
      const prev: Message[] = [
        mkMsg("opt-1", "user", "skip the tests", undefined, status),
      ];
      const incoming: Message[] = [
        mkMsg("s2", "user", "skip the tests", 1),
      ];
      const out = appendUnique(prev, incoming);
      expect(out.map((m) => m.id)).toEqual(["s2"]);
      expect(out[0].status).toBe("confirmed");
    },
  );

  it("reorders by seq when an out-of-order server row arrives", () => {
    // Steer race: a user bubble is appended optimistically while the previous
    // reply is still being persisted server-side. Without a seq-based sort
    // that reply lands after the user bubble even though it was persisted
    // first — created_at can't disambiguate this (both fixtures share one
    // timestamp), only the server-assigned seq can.
    const prev: Message[] = [
      mkMsg("u1", "user", "first", 1, "confirmed"),
      mkMsg("opt-2", "user", "steer", undefined, "pending"),
    ];
    const incoming: Message[] = [
      mkMsg("a1", "assistant", "partial ⏸ Interrupted", 2),
      mkMsg("u2", "user", "steer", 3),
    ];
    const out = appendUnique(prev, incoming);
    expect(out.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("appends genuinely new server rows in seq order", () => {
    const prev: Message[] = [
      mkMsg("u1", "user", "hi", 1, "confirmed"),
    ];
    const incoming: Message[] = [
      mkMsg("a1", "assistant", "hello there", 2),
    ];
    const out = appendUnique(prev, incoming);
    expect(out.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("is idempotent when incoming duplicates prev by id", () => {
    const prev: Message[] = [
      mkMsg("u1", "user", "hi", 1, "confirmed"),
      mkMsg("a1", "assistant", "hello", 2, "confirmed"),
    ];
    const out = appendUnique(prev, prev);
    expect(out.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(out.every((m) => m.status === "confirmed")).toBe(true);
  });

  it("preserves relative order for multiple pending bubbles with no seq yet (stable sort)", () => {
    const prev: Message[] = [
      mkMsg("u1", "user", "hi", 1, "confirmed"),
    ];
    const incoming: Message[] = [
      mkMsg("a1", "assistant", "one"),
      mkMsg("a2", "assistant", "two"),
    ];
    const out = appendUnique(prev, incoming);
    expect(out.map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
  });
});

describe("applyThreadMeta", () => {
  function recorder(): { meta: ThreadMetaApplier; calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = {};
    const push = (key: string) => (value: unknown) => { calls[key] = [...(calls[key] ?? []), value]; };
    return {
      calls,
      meta: {
        setHotSince: push("hotSince") as (v: string | null) => void,
        setWarmSummary: push("warmSummary") as (v: string | null) => void,
        setWarmSummaryBefore: push("warmSummaryBefore") as (v: string | null) => void,
        setWarmSummaryComputedAt: push("warmSummaryComputedAt") as (v: string | null) => void,
        setWarmSummarySourceMessages: push("warmSummarySourceMessages") as (v: number | null) => void,
        setWarmSummarySourceChars: push("warmSummarySourceChars") as (v: number | null) => void,
        setContextWindowTokens: push("contextWindowTokens") as (v: number | null) => void,
        setWarmSummaryPending: push("warmSummaryPending") as (v: boolean) => void,
      },
    };
  }

  it("marks an observed hot_since as pending until its matching summary arrives", () => {
    const { meta, calls } = recorder();

    applyThreadMeta(meta, {
      hot_since: "2026-08-28T07:00:00.000Z",
      warm_summary: null,
      warm_summary_before: null,
    });

    expect(calls.hotSince).toEqual(["2026-08-28T07:00:00.000Z"]);
    expect(calls.warmSummaryPending).toEqual([true]);
  });

  it("clears pending once the warm summary covers the current boundary", () => {
    const { meta, calls } = recorder();

    applyThreadMeta(meta, {
      hot_since: "2026-08-28T07:00:00.000Z",
      warm_summary: "summary",
      warm_summary_before: "2026-08-28T07:00:00.000Z",
    });

    expect(calls.warmSummaryPending).toEqual([false]);
  });
});
