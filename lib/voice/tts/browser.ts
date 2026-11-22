// Browser speech synthesis for spoken replies (no key, no network).
//
// Used when the agent's speech engine is Browser or Whisper. Gemini keeps
// Gemini TTS; Whisper only transcribes, so it cannot synthesize and maps to
// the operating system's voices here.

export interface BrowserSpeechHandlers {
  onEnd?: () => void;
  onError?: (error: string) => void;
}

export interface BrowserSpeechSession {
  pause(): void;
  resume(): void;
  cancel(): void;
}

export function isBrowserTtsAvailable(): boolean {
  if (typeof window === "undefined") return false;
  return typeof window.speechSynthesis?.speak === "function"
    && typeof window.SpeechSynthesisUtterance === "function";
}

export function speakWithBrowser(text: string, handlers: BrowserSpeechHandlers = {}): BrowserSpeechSession | null {
  if (!isBrowserTtsAvailable()) return null;
  const synth = window.speechSynthesis;
  const utterance = new window.SpeechSynthesisUtterance(text);
  utterance.lang = document.documentElement?.lang || navigator.language || "en-US";
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;

  let cancelled = false;
  utterance.onend = () => {
    if (!cancelled) handlers.onEnd?.();
  };
  utterance.onerror = (event) => {
    if (cancelled) return;
    // Starting another clip cancels the previous one; that is not an error.
    if (event.error === "interrupted" || event.error === "canceled") {
      handlers.onEnd?.();
      return;
    }
    handlers.onError?.(event.error || "playback failed");
  };

  // One clip at a time: a new Play press replaces whatever is speaking.
  try { synth.cancel(); } catch { /* not speaking */ }
  synth.speak(utterance);

  return {
    pause() {
      try { synth.pause(); } catch { /* unsupported */ }
    },
    resume() {
      try { synth.resume(); } catch { /* unsupported */ }
    },
    cancel() {
      cancelled = true;
      try { synth.cancel(); } catch { /* not speaking */ }
    },
  };
}
