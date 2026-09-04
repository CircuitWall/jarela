import { describe, it, expect } from "vitest";
import type { Message } from "@/api/types";
import { appendUnique, applyThreadMeta, type ThreadMetaApplier } from "./chat-helpers";

const mkMsg = (id: string, role: "user" | "assistant", content: string, created_at: string, status?: "pending" | "confirmed"): Message => ({
  id,
  role,
  content,
  created_at,
  ...(status ? { status } : {}),
});

describe("appendUnique — ordering", () => {
  it("promotes a pending user bubble in place when the server row arrives", () => {
    const prev: Message[] = [
      mkMsg("s1", "user", "hello", "2026-08-01T10:00:00.000Z", "confirmed"),
      mkMsg("opt-1", "user", "world", "2026-08-01T10:00:01.000Z", "pending"),
    ];
    const incoming: Message[] = [
      mkMsg("s2", "user", "world", "2026-08-01T10:00:01.000Z"),
    ];
    const out = appendUnique(prev, incoming);
    expect(out.map((m) => m.id)).toEqual(["s1", "s2"]);
    expect(out[1].status).toBe("confirmed");
  });

  it("reorders by created_at when an out-of-order server row arrives", () => {
    // Steer race: a user bubble is appended optimistically while the previous
    // reply is still being persisted server-side. Without a chronological sort
    // that reply lands after the user bubble even though it happened earlier.
    const prev: Message[] = [
      mkMsg("u1", "user", "first", "2026-08-01T10:00:00.000Z", "confirmed"),
      mkMsg("opt-2", "user", "steer", "2026-08-01T10:00:05.000Z", "pending"),
    ];
    const incoming: Message[] = [
      mkMsg("a1", "assistant", "partial ⏸ Interrupted", "2026-08-01T10:00:03.000Z"),
      mkMsg("u2", "user", "steer", "2026-08-01T10:00:05.000Z"),
    ];
    const out = appendUnique(prev, incoming);
    expect(out.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("appends genuinely new server rows in chronological order", () => {
    const prev: Message[] = [
      mkMsg("u1", "user", "hi", "2026-08-01T10:00:00.000Z", "confirmed"),
    ];
    const incoming: Message[] = [
      mkMsg("a1", "assistant", "hello there", "2026-08-01T10:00:01.000Z"),
    ];
    const out = appendUnique(prev, incoming);
    expect(out.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("is idempotent when incoming duplicates prev by id", () => {
    const prev: Message[] = [
      mkMsg("u1", "user", "hi", "2026-08-01T10:00:00.000Z", "confirmed"),
      mkMsg("a1", "assistant", "hello", "2026-08-01T10:00:01.000Z", "confirmed"),
    ];
    const out = appendUnique(prev, prev);
    expect(out.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(out.every((m) => m.status === "confirmed")).toBe(true);
  });

  it("preserves relative order for messages with identical timestamps (stable sort)", () => {
    const prev: Message[] = [
      mkMsg("u1", "user", "hi", "2026-08-01T10:00:00.000Z", "confirmed"),
    ];
    const incoming: Message[] = [
      mkMsg("a1", "assistant", "one", "2026-08-01T10:00:01.000Z"),
      mkMsg("a2", "assistant", "two", "2026-08-01T10:00:01.000Z"),
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
