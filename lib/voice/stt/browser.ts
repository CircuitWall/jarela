// Browser speech recognition engine (ADR-0123).
//
// Uses the Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`),
// which is free, needs no key, and streams interim text — at the cost of
// being Chromium/Safari-only and noticeably weaker on technical vocabulary.
// Chrome/Edge send audio to the vendor's ASR service; Jarela never sees it.
import type { SttSession, SttStartOptions } from "./types";

interface SpeechAlternativeLike {
  transcript: string;
}

interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechAlternativeLike;
}

interface SpeechResultListLike {
  readonly length: number;
  [index: number]: SpeechResultLike;
}

interface SpeechResultEventLike {
  resultIndex: number;
  results: SpeechResultListLike;
}

interface SpeechErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: SpeechErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export function isBrowserSttAvailable(): boolean {
  return recognitionCtor() !== null;
}

function describeSpeechError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Speech recognition is blocked. Allow microphone access for this site, then try again.";
    case "audio-capture":
      return "No microphone was found for speech recognition.";
    case "network":
      return "Browser speech recognition needs a network connection in this browser.";
    case "language-not-supported":
      return "This browser does not support the selected speech language.";
    default:
      return `Speech recognition failed (${code}).`;
  }
}

/**
 * Start a browser recognition session. Returns immediately; text arrives via
 * `onPartial` and the final transcript is resolved by `stop()`.
 *
 * `onend` without an explicit `stop()` means the browser ended the session on
 * its own (silence, or Safari's non-continuous mode) — that is treated as the
 * end of the turn.
 */
export function startBrowserStt({ lang, onPartial, onEnd }: SttStartOptions = {}): SttSession {
  const Ctor = recognitionCtor();
  if (!Ctor) throw new Error("This browser has no built-in speech recognition. Choose Whisper or Gemini in the agent's voice settings.");

  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.lang = lang || (typeof navigator !== "undefined" ? navigator.language : "en-US");

  let finalText = "";
  let failure: string | null = null;
  let settled = false;
  let stopRequested = false;
  let resolveDone: (text: string) => void = () => {};
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

  const done = new Promise<string>((resolve) => {
    resolveDone = resolve;
  });

  function settle() {
    if (settled) return;
    settled = true;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    const text = finalText.trim();
    resolveDone(text);
    // An unsolicited end must tell the caller, otherwise the capture UI
    // latches on a session that is no longer listening.
    if (!stopRequested) {
      try {
        onEnd?.({ text, error: failure });
      } catch { /* a listener failure must not break the session */ }
    }
  }

  function abortQuietly() {
    try { recognition.abort(); } catch { /* already stopped */ }
  }

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? "";
      if (result.isFinal) finalText += text;
      else interim += text;
    }
    const combined = `${finalText}${interim}`.trim();
    if (combined) onPartial?.(combined);
  };
  recognition.onerror = (event) => {
    // `no-speech` is a normal empty turn, not an error worth shouting about.
    if (event.error !== "no-speech") failure = describeSpeechError(event.error);
    abortQuietly();
    settle();
  };
  recognition.onend = () => {
    settle();
  };

  try {
    recognition.start();
  } catch (error) {
    recognition.onend = null;
    recognition.onerror = null;
    throw error instanceof Error ? error : new Error("Speech recognition could not start");
  }

  return {
    engine: "browser",
    async stop() {
      stopRequested = true;
      if (!settled) {
        try { recognition.stop(); } catch { /* already stopped */ }
        // Some engines never fire `onend` after `stop()`; do not hang the UI,
        // and make sure a stale session cannot block the next `start()`.
        fallbackTimer = setTimeout(() => {
          abortQuietly();
          settle();
        }, 4_000);
      }
      await done;
      if (failure) throw new Error(failure);
      return finalText.trim();
    },
    cancel() {
      stopRequested = true;
      abortQuietly();
      settle();
    },
  };
}
