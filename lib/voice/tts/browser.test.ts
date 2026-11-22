// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBrowserTtsAvailable, speakWithBrowser } from "./browser";

class FakeUtterance {
  lang = "";
  rate = 1;
  pitch = 1;
  volume = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(readonly text: string) { /* captured */ }
}

const speak = vi.fn();
const pause = vi.fn();
const resume = vi.fn();
const cancel = vi.fn();

beforeEach(() => {
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("speechSynthesis", { speak, pause, resume, cancel });
});

afterEach(() => {
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

  it("speaks the reply and reports completion", () => {
    const onEnd = vi.fn();
    const session = speakWithBrowser("hello there", { onEnd });

    expect(session).not.toBeNull();
    expect(speak).toHaveBeenCalledTimes(1);
    const utterance = lastUtterance();
    expect(utterance.text).toBe("hello there");
    expect(utterance.lang).toBeTruthy();

    utterance.onend?.();
    expect(onEnd).toHaveBeenCalledTimes(1);

    session?.pause();
    session?.resume();
    expect(pause).toHaveBeenCalled();
    expect(resume).toHaveBeenCalled();
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
