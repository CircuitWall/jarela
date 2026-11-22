// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { startBrowserStt } from "./browser";

type FakeResult = { isFinal: boolean; length: number; 0: { transcript: string } };

function speech(transcript: string, isFinal: boolean): FakeResult {
  return Object.assign([{ transcript }], { isFinal }) as unknown as FakeResult;
}

class FakeRecognition {
  static latest: FakeRecognition | null = null;
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 1;
  onresult: ((event: { resultIndex: number; results: FakeResult[] }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.latest = this;
  }
  start() { /* started */ }
  stop() { this.onend?.(); }
  abort() { this.onend?.(); }
  emit(results: FakeResult[], resultIndex = 0) {
    this.onresult?.({ resultIndex, results });
  }
}

function start(onPartial?: (text: string) => void) {
  FakeRecognition.latest = null;
  Object.defineProperty(window, "SpeechRecognition", {
    value: FakeRecognition,
    configurable: true,
    writable: true,
  });
  const session = startBrowserStt({ onPartial });
  const recognition = FakeRecognition.latest!;
  return { session, recognition };
}

afterEach(() => {
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
});

describe("browser stt transcript", () => {
  it("separates adjacent results instead of fusing them", async () => {
    const { session, recognition } = start();
    recognition.emit([speech("Good", true), speech("morning", true)]);
    await expect(session.stop()).resolves.toBe("Good morning");
  });

  it("keeps a phrase spoken after the recognizer restarts", async () => {
    const { session, recognition } = start();
    recognition.emit([speech("first part", true)]);
    recognition.emit([speech("second part", true)]);
    await expect(session.stop()).resolves.toBe("first part second part");
  });

  it("ignores a final result the recognizer re-emits", async () => {
    const { session, recognition } = start();
    const final = speech("No voice conversation", true);
    recognition.emit([final], 0);
    recognition.emit([final], 0);
    await expect(session.stop()).resolves.toBe("No voice conversation");
  });

  it("does not replay a phrase finalized before a restart", async () => {
    const { session, recognition } = start();
    recognition.emit([speech("No voice conversation", true)]);
    recognition.emit([speech("No voice conversation", true)]);
    await expect(session.stop()).resolves.toBe("No voice conversation");
  });

  it("previews interim text alongside what is already final", () => {
    const partials: string[] = [];
    const { recognition } = start((text) => partials.push(text));
    recognition.emit([speech("done", true), speech("still", false), speech("talking", false)]);
    expect(partials.at(-1)).toBe("done still talking");
  });
});
