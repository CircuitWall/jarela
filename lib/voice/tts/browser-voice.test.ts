// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserVoiceKey, isBrowserVoiceMissing, listBrowserVoices, resolveBrowserVoice } from "./browser-voice";

type FakeVoice = { name: string; lang: string; voiceURI: string; localService?: boolean };

function installVoices(voices: FakeVoice[]) {
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: { getVoices: () => voices as unknown as SpeechSynthesisVoice[] },
  });
}

beforeEach(() => {
  Reflect.deleteProperty(window, "speechSynthesis");
});

afterEach(() => {
  Reflect.deleteProperty(window, "speechSynthesis");
  vi.restoreAllMocks();
});

describe("browser voice catalogue", () => {
  it("returns nothing when the browser has no speech synthesis", () => {
    expect(listBrowserVoices()).toEqual([]);
    expect(resolveBrowserVoice("anything")).toBeNull();
  });

  it("lists voices sorted by language, with a readable label", () => {
    installVoices([
      { name: "Zira", lang: "en-US", voiceURI: "zira" },
      { name: "Hazel", lang: "en-GB", voiceURI: "hazel" },
      { name: "George", lang: "en-GB", voiceURI: "george" },
    ]);
    expect(listBrowserVoices().map((voice) => voice.label)).toEqual([
      "George — en-GB",
      "Hazel — en-GB",
      "Zira — en-US",
    ]);
  });

  it("keys a voice by its URI and falls back to the name", () => {
    expect(browserVoiceKey({ name: "Hazel", voiceURI: "urn:hazel" } as SpeechSynthesisVoice)).toBe("urn:hazel");
    expect(browserVoiceKey({ name: "Hazel", voiceURI: "  " } as SpeechSynthesisVoice)).toBe("Hazel");
  });

  it("resolves a stored key by URI or by name", () => {
    installVoices([
      { name: "Hazel", lang: "en-GB", voiceURI: "urn:hazel" },
      { name: "George", lang: "en-GB", voiceURI: "" },
    ]);
    expect(resolveBrowserVoice("urn:hazel")?.name).toBe("Hazel");
    expect(resolveBrowserVoice("George")?.name).toBe("George");
    expect(resolveBrowserVoice("  ")).toBeNull();
  });

  it("reports a key this device cannot speak with", () => {
    installVoices([{ name: "Hazel", lang: "en-GB", voiceURI: "urn:hazel" }]);
    expect(isBrowserVoiceMissing("urn:hazel")).toBe(false);
    expect(isBrowserVoiceMissing("urn:missing")).toBe(true);
    expect(isBrowserVoiceMissing("")).toBe(false);
    // An empty voice list means "not loaded yet", not "missing".
    installVoices([]);
    expect(isBrowserVoiceMissing("urn:hazel")).toBe(false);
  });
});
