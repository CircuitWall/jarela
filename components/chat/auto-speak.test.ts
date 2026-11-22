import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAutoSpeak,
  consumeAutoSpeak,
  requestAutoSpeak,
  subscribeAutoSpeak,
} from "./auto-speak";

beforeEach(() => {
  _resetAutoSpeak();
});

describe("auto-speak handoff", () => {
  it("parks a request until the target message consumes it", () => {
    requestAutoSpeak("msg-1");
    expect(consumeAutoSpeak("msg-1")).toBe(true);
    expect(consumeAutoSpeak("msg-1")).toBe(false);
  });

  it("delivers immediately to a live listener without parking", () => {
    const seen: string[] = [];
    subscribeAutoSpeak((id) => {
      seen.push(id);
      return true;
    });
    requestAutoSpeak("msg-2");
    expect(seen).toEqual(["msg-2"]);
    expect(consumeAutoSpeak("msg-2")).toBe(false);
  });

  it("falls back to parking when a listener does not handle the request", () => {
    subscribeAutoSpeak(() => false);
    requestAutoSpeak("msg-3");
    expect(consumeAutoSpeak("msg-3")).toBe(true);
  });

  it("does not replay after a listener handled the request and the bubble mounts", () => {
    subscribeAutoSpeak((id) => id === "msg-4");
    requestAutoSpeak("msg-4");
    expect(consumeAutoSpeak("msg-4")).toBe(false);
  });

  it("drops requests older than the TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    requestAutoSpeak("old");
    vi.setSystemTime(31_000);
    requestAutoSpeak("fresh");
    expect(consumeAutoSpeak("old")).toBe(false);
    expect(consumeAutoSpeak("fresh")).toBe(true);
    vi.useRealTimers();
  });
});
