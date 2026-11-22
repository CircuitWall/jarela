import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAutoSpeak,
  consumeAutoSpeak,
  consumeLiveSpeech,
  markLiveSpeechSpoken,
  requestAutoSpeak,
  requestLiveSpeech,
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

  it("does not read the reply twice when it was already spoken live", () => {
    requestLiveSpeech();
    expect(consumeLiveSpeech()).toBe(true);
    markLiveSpeechSpoken();
    requestAutoSpeak("msg-live");
    expect(consumeAutoSpeak("msg-live")).toBe(false);
  });

  it("still reads the finished reply when live reading never started", () => {
    requestLiveSpeech();
    expect(consumeLiveSpeech()).toBe(true);
    // A reader that dies before its first clip keeps the finalize request, so
    // a development remount or a missing voice degrades instead of going mute.
    requestAutoSpeak("msg-muted");
    expect(consumeAutoSpeak("msg-muted")).toBe(true);
  });

  it("keeps the finalize request when the live reader never started", () => {
    requestLiveSpeech();
    requestAutoSpeak("msg-idle");
    expect(consumeAutoSpeak("msg-idle")).toBe(true);
    // The stale intent must not leak into the next reply.
    expect(consumeLiveSpeech()).toBe(false);
  });
});
