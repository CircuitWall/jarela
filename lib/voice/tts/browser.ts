// Browser speech synthesis for spoken replies (no key, no network).
//
// Used when the agent's speech engine is Browser or Whisper. Gemini keeps
// Gemini TTS; Whisper only transcribes, so it cannot synthesize and maps to
// the operating system's voices here.
//
// `speechSynthesis.speak()` can accept an utterance and then never start it
// (paused synth, no output device, browser quirk). A short watchdog turns
// that silence into a visible error instead of a stuck "playing" state.

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
}

export function isBrowserTtsAvailable(): boolean {
  if (typeof window === "undefined") return false;
  return typeof window.speechSynthesis?.speak === "function"
    && typeof window.SpeechSynthesisUtterance === "function";
}

export function speakWithBrowser(
  text: string,
  handlers: BrowserSpeechHandlers = {},
  options: BrowserSpeechOptions = {},
): BrowserSpeechSession | null {
  if (!isBrowserTtsAvailable()) return null;
  const synth = window.speechSynthesis;
  const utterance = new window.SpeechSynthesisUtterance(text);
  utterance.lang = document.documentElement?.lang || navigator.language || "en-US";
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;

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
