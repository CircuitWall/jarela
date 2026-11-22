// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveSpeechQueue, type LiveSpeechHandlers } from "./live-speech";

const spoken: string[] = [];
const utterances: FakeUtterance[] = [];
let objectUrls = 0;
const cancelSpy = vi.fn();

function handlers() {
  return {
    onStart: vi.fn(),
    onDrain: vi.fn(),
    onError: vi.fn(),
  } satisfies LiveSpeechHandlers;
}

function wait(ms = 5) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeUtterance {
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: { name: string; lang: string } | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

afterEach(() => {
  spoken.length = 0;
  utterances.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cancelSpy.mockClear();
});

function useBrowserVoices({ failFirstSpeak = false } = {}) {
  let failed = false;
  const synth = {
    paused: false,
    speaking: false,
    pending: false,
    getVoices: () => [{ name: "Hazel", lang: "en-GB", voiceURI: "urn:hazel" }],
    speak(utterance: FakeUtterance) {
      utterances.push(utterance);
      if (failFirstSpeak && !failed) {
        failed = true;
        setTimeout(() => utterance.onerror?.({ error: "synthesis-failed" }), 0);
        return;
      }
      spoken.push(utterance.text);
      synth.speaking = true;
      setTimeout(() => {
        synth.speaking = false;
        utterance.onstart?.();
        utterance.onend?.();
      }, 0);
    },
    cancel() {
      cancelSpy();
    },
    pause() { /* unused */ },
    resume() { /* unused */ },
  };
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
}

function useGeminiAudio() {
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public src: string) {
      spoken.push(src);
    }
    play() {
      setTimeout(() => this.onended?.(), 0);
      return Promise.resolve();
    }
    pause() { /* unused */ }
  }
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    blob: async () => new Blob(["audio"]),
  })));
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => `blob:${++objectUrls}`,
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => { /* noop */ } });
}

describe("createLiveSpeechQueue", () => {
  it("speaks slices one at a time and reports start once", async () => {
    useBrowserVoices();
    const h = handlers();
    const queue = createLiveSpeechQueue({ engine: "browser", agentId: "agent-1", handlers: h })!;

    queue.push("First sentence.");
    await wait();
    queue.push("Second sentence.");
    queue.finish();
    await wait(20);

    expect(spoken).toEqual(["First sentence.", "Second sentence."]);
    expect(h.onStart).toHaveBeenCalledTimes(1);
    expect(h.onDrain).toHaveBeenCalledTimes(1);
    expect(h.onError).not.toHaveBeenCalled();
    // Back-to-back slices must not cancel first: Chromium drops the new clip
    // and the start watchdog then reports a failure the user can hear through.
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("retries a slice the browser refused to start", async () => {
    useBrowserVoices({ failFirstSpeak: true });
    const h = handlers();
    const queue = createLiveSpeechQueue({ engine: "browser", agentId: "agent-1", handlers: h })!;

    queue.push("Recovered sentence.");
    queue.finish();
    await wait(250);

    expect(spoken).toEqual(["Recovered sentence."]);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onDrain).toHaveBeenCalledTimes(1);
  });

  it("reads with the agent's chosen device voice and tone", async () => {
    useBrowserVoices();
    const h = handlers();
    const queue = createLiveSpeechQueue({
      engine: "browser",
      agentId: "agent-1",
      browserVoice: "urn:hazel",
      handlers: h,
    })!;

    queue.push("[[tone: whisper]] Quietly now.");
    queue.finish();
    await wait(20);

    expect(utterances[0]?.voice?.name).toBe("Hazel");
    expect(utterances[0]?.lang).toBe("en-GB");
    expect(utterances[0]?.volume).toBeLessThan(0.5);
  });

  it("drops queued slices once cancelled", async () => {
    useBrowserVoices();
    const h = handlers();
    const queue = createLiveSpeechQueue({ engine: "browser", agentId: "agent-1", handlers: h })!;

    queue.push("Only this one.");
    await wait();
    queue.cancel();
    queue.push("Never spoken.");
    queue.finish();
    await wait(20);

    expect(spoken).not.toContain("Never spoken.");
    expect(h.onDrain).not.toHaveBeenCalled();
  });

  it("plays synthesized clips in order for Gemini agents", async () => {
    useGeminiAudio();
    const h = handlers();
    const queue = createLiveSpeechQueue({ engine: "gemini", agentId: "agent-1", handlers: h })!;

    queue.push("One.");
    queue.push("Two.");
    queue.finish();
    await wait(30);

    expect(spoken).toEqual(["blob:1", "blob:2"]);
    expect(h.onStart).toHaveBeenCalledTimes(1);
    expect(h.onDrain).toHaveBeenCalledTimes(1);
  });

  it("ignores tone directives and wordless slices", async () => {
    useBrowserVoices();
    const h = handlers();
    const queue = createLiveSpeechQueue({ engine: "browser", agentId: "agent-1", handlers: h })!;

    queue.push("[[tone: warm]] Hello there.");
    queue.push("| --- |");
    queue.finish();
    await wait(20);

    expect(spoken).toEqual(["Hello there."]);
  });

  it("has nothing to do without an engine", () => {
    expect(createLiveSpeechQueue({
      engine: "gemini",
      agentId: null,
      handlers: handlers(),
    })).toBeNull();
  });
});
