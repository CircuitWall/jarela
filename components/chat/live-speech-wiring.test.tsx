// @vitest-environment jsdom
// End-to-end wiring check for "the reply is read sentence by sentence".
//
// The unit suites cover the splitter and the queue separately; this one drives
// the hook with the real queue and a fake `speechSynthesis`, inside React
// StrictMode — which is on by default for the App Router in development and
// remounts effects once. That remount is what used to cancel the freshly
// created reader before its first clip, so a voice turn came out silent.
import { StrictMode, type ReactElement } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@/api/types";

const spoken: string[] = [];

class FakeUtterance {
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

function installSpeech() {
  const synth = {
    paused: false,
    speaking: false,
    pending: false,
    getVoices: () => [{ name: "Hazel", lang: "en-GB", voiceURI: "urn:hazel" }],
    speak(utterance: FakeUtterance) {
      spoken.push(utterance.text);
      setTimeout(() => {
        utterance.onstart?.();
        utterance.onend?.();
      }, 0);
    },
    cancel() { /* one clip at a time */ },
    pause() { /* unused */ },
    resume() { /* unused */ },
  };
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
}

const { _resetAutoSpeak, requestLiveSpeech } = await import("./auto-speak");
const { _resetLiveSpeech, useLiveSpeech } = await import("./use-live-speech");
const { _resetVoiceConversation, consumeVoiceListen } = await import("./voice-conversation");

const AGENT = {
  id: "agent-1",
  voice_enabled: true,
  voice_stt_engine: "browser",
  voice_browser_voice: "urn:hazel",
} as AgentConfig;

function Probe({ content, streaming }: { content: string; streaming: boolean }) {
  useLiveSpeech({ content, streaming, agentConfig: AGENT });
  return null;
}

function strict(ui: ReactElement) {
  return render(<StrictMode>{ui}</StrictMode>);
}

beforeEach(() => {
  _resetAutoSpeak();
  _resetLiveSpeech();
  _resetVoiceConversation();
  spoken.length = 0;
  installSpeech();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("live speech wiring", () => {
  it("reads a streamed reply one sentence at a time under StrictMode", async () => {
    requestLiveSpeech();
    const view = strict(<Probe content="First sentence. " streaming />);

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(spoken).toEqual(["First sentence."]);

    view.rerender(<StrictMode><Probe content="First sentence. Second sentence. And" streaming /></StrictMode>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(spoken).toEqual(["First sentence.", "Second sentence."]);

    view.rerender(<StrictMode><Probe content="First sentence. Second sentence. And done." streaming={false} /></StrictMode>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(spoken).toEqual(["First sentence.", "Second sentence.", "And done."]);
    expect(consumeVoiceListen()).toBe(true);
  });

  it("stays quiet for a turn that did not arrive as speech", async () => {
    strict(<Probe content="A typed answer." streaming={false} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(spoken).toEqual([]);
  });
});
