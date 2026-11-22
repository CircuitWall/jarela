// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBrowserTtsAvailable, speakWithBrowser } from "./browser";

class FakeUtterance {
  lang = "";
  rate = 1;
  pitch = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(readonly text: string) { /* captured */ }
}

const speak = vi.fn();
const pause = vi.fn();
const resume = vi.fn();
const cancel = vi.fn();
const synth = { speaking: false, paused: false, speak, pause, resume, cancel };

beforeEach(() => {
  synth.speaking = false;
  synth.paused = false;
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("speechSynthesis", synth);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function lastUtterance(): FakeUtterance {
  return speak.mock.calls[speak.mock.calls.length - 1][0] as FakeUtterance;
}

describe("browser speech synthesis", () => {
  it("is available only when the browser exposes speech synthesis", () => {
    expect(isBrowserTtsAvailable()).toBe(true);
    vi.unstubAllGlobals();
    expect(isBrowserTtsAvailable()).toBe(false);
  });

  it("speaks the reply and reports start and completion", () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const session = speakWithBrowser("hello there", { onStart, onEnd });

    expect(session).not.toBeNull();
    expect(speak).toHaveBeenCalledTimes(1);
    const utterance = lastUtterance();
    expect(utterance.text).toBe("hello there");
    expect(utterance.lang).toBeTruthy();

    utterance.onstart?.();
    expect(onStart).toHaveBeenCalledTimes(1);
    utterance.onend?.();
    expect(onEnd).toHaveBeenCalledTimes(1);

    session?.pause();
    session?.resume();
    expect(pause).toHaveBeenCalled();
    expect(resume).toHaveBeenCalled();
  });

  it("reports when speech never actually starts", () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    speakWithBrowser("hello", { onError });
    vi.advanceTimersByTime(2_100);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/did not start/));
    expect(cancel).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("trusts the synth state when it is speaking without a start event", () => {
    vi.useFakeTimers();
    const onStart = vi.fn();
    const onError = vi.fn();
    speakWithBrowser("hello", { onStart, onError });
    synth.speaking = true;
    vi.advanceTimersByTime(2_100);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("treats an interrupted clip as a normal end", () => {
    const onEnd = vi.fn();
    const onError = vi.fn();
    speakWithBrowser("first", { onEnd, onError });
    lastUtterance().onerror?.({ error: "interrupted" });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a real synthesis error", () => {
    const onError = vi.fn();
    speakWithBrowser("hello", { onError });
    lastUtterance().onerror?.({ error: "synthesis-failed" });
    expect(onError).toHaveBeenCalledWith("synthesis-failed");
  });

  it("does not report completion after cancel", () => {
    const onEnd = vi.fn();
    const session = speakWithBrowser("hello", { onEnd });
    session?.cancel();
    lastUtterance().onend?.();
    expect(cancel).toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("returns null when speech synthesis is unavailable", () => {
    vi.unstubAllGlobals();
    expect(speakWithBrowser("hello")).toBeNull();
  });
});
