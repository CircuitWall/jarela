// Browser speech synthesis for spoken replies (no key, no network).
//
// Used when the agent's speech engine is Browser or Whisper. Gemini keeps
// Gemini TTS; Whisper only transcribes, so it cannot synthesize and maps to
// the operating system's voices here.
//
// `speechSynthesis.speak()` can accept an utterance and then never start it
// (paused synth, no output device, browser quirk). A short watchdog turns
// that silence into a visible error instead of a stuck "playing" state.

import { resolveBrowserVoice } from "./browser-voice";
import { browserProsody } from "./prosody";

const START_TIMEOUT_MS = 2_000;

export interface BrowserSpeechHandlers {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
}

export interface BrowserSpeechSession {
  pause(): void;
  resume(): void;
  cancel(): void;
}

export interface BrowserSpeechOptions {
  /**
   * Cancel a clip that is already speaking (a manual Play replaces it).
   * Sequential slices pass false: Chromium silently drops a `speak()` that
   * follows a `cancel()` on an idle synth, which then trips the start
   * watchdog and reports a failure for audio the user actually hears.
   */
  replace?: boolean;
  /** Stored voice key (see browser-voice.ts). Empty = the device default. */
  voice?: string | null;
  /** `[[tone: …]]` note, approximated as rate/pitch/volume. */
  style?: string | null;
}

export function isBrowserTtsAvailable(): boolean {
  if (typeof window === "undefined") return false;
  return typeof window.speechSynthesis?.speak === "function"
    && typeof window.SpeechSynthesisUtterance === "function";
}

/**
 * Mobile Safari only allows a `speak()` that runs inside a user gesture to arm
 * the synthesiser; every later utterance from a timer or a stream callback is
 * silently dropped until the page has done that once — even an empty utterance
 * is enough ("an utterance (even a blank one) during a user interaction to
 * enable utterances during timeouts", SO 61658740). Call this from the same
 * click that starts capture, so the reply can be read aloud minutes later.
 */
export function unlockBrowserSpeech(): void {
  if (!isBrowserTtsAvailable()) return;
  const synth = window.speechSynthesis;
  try {
    if (synth.paused) synth.resume();
    const primer = new window.SpeechSynthesisUtterance("");
    primer.volume = 0;
    synth.speak(primer);
  } catch {
    /* nothing to unlock in this browser */
  }
}

export function speakWithBrowser(
  text: string,
  handlers: BrowserSpeechHandlers = {},
  options: BrowserSpeechOptions = {},
): BrowserSpeechSession | null {
  if (!isBrowserTtsAvailable()) return null;
  const synth = window.speechSynthesis;
  const utterance = new window.SpeechSynthesisUtterance(text);
  const selected = resolveBrowserVoice(options.voice);
  if (selected) utterance.voice = selected;
  utterance.lang = (selected?.lang || "").trim()
    || document.documentElement?.lang
    || navigator.language
    || "en-US";
  const prosody = browserProsody(options.style);
  utterance.rate = prosody.rate;
  utterance.pitch = prosody.pitch;
  utterance.volume = prosody.volume;

  let started = false;
  let settled = false;
  let cancelled = false;

  const startTimer = setTimeout(() => {
    if (settled || started) return;
    // Some engines speak without firing `start`; a clip that is speaking or
    // still queued behind another one is not a failure.
    if (synth.speaking || synth.pending) {
      started = true;
      handlers.onStart?.();
      return;
    }
    settled = true;
    cancelled = true;
    try { synth.cancel(); } catch { /* not speaking */ }
    handlers.onError?.(
      "the browser did not start speech synthesis — check the system voice output, or switch the speech engine to Gemini",
    );
  }, START_TIMEOUT_MS);

  function clearStart() {
    clearTimeout(startTimer);
  }

  utterance.onstart = () => {
    if (settled) return;
    started = true;
    clearStart();
    handlers.onStart?.();
  };
  utterance.onend = () => {
    clearStart();
    if (settled) return;
    settled = true;
    if (!cancelled) handlers.onEnd?.();
  };
  utterance.onerror = (event) => {
    clearStart();
    if (settled) return;
    settled = true;
    // Starting another clip cancels the previous one; that is not an error.
    if (event.error === "interrupted" || event.error === "canceled") {
      handlers.onEnd?.();
      return;
    }
    handlers.onError?.(event.error || "playback failed");
  };

  // One clip at a time: a new Play press replaces whatever is speaking.
  if (options.replace !== false) {
    try {
      if (synth.speaking || synth.pending || synth.paused) synth.cancel();
    } catch { /* not speaking */ }
  }
  try {
    if (synth.paused) synth.resume();
    synth.speak(utterance);
  } catch {
    clearStart();
    settled = true;
    return null;
  }

  return {
    pause() {
      try { synth.pause(); } catch { /* unsupported */ }
    },
    resume() {
      try { synth.resume(); } catch { /* unsupported */ }
    },
    cancel() {
      cancelled = true;
      settled = true;
      clearStart();
      try { synth.cancel(); } catch { /* not speaking */ }
    },
  };
}
