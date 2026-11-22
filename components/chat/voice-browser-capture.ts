// Browser-engine hands-free capture (Web Speech API).
//
// Web Speech owns the microphone, so "silence" is transcript inactivity: each
// partial re-arms a short pause timer and a longer end timer. The composer
// shows "Paused — keep talking" between the two, and the turn sends itself at
// the longer silence.
import { startBrowserStt } from "@/lib/voice/stt/browser";
import { VOICE_TIMING } from "@/lib/voice/stt/silence";
import { errorMessage } from "@/lib/utils/error";
import type { CaptureControls } from "./voice-capture-types";

export interface BrowserCaptureHandlers {
  onRecording(recording: boolean): void;
  onPaused(paused: boolean): void;
  onPartial(text: string): void;
  onTranscript(text: string): void;
  onError(message: string): void;
}

export interface BrowserCaptureOptions {
  /** Leading silence before the capture aborts. Conversation mode uses 5 s. */
  noSpeechMs?: number;
}

export function startBrowserCapture(
  handlers: BrowserCaptureHandlers,
  options: BrowserCaptureOptions = {},
): CaptureControls {
  let session: ReturnType<typeof startBrowserStt> | null = null;
  let settled = false;
  let timers: {
    pause?: ReturnType<typeof setTimeout>;
    end?: ReturnType<typeof setTimeout>;
    noSpeech?: ReturnType<typeof setTimeout>;
  } = {};

  function clearTimers() {
    if (timers.pause) clearTimeout(timers.pause);
    if (timers.end) clearTimeout(timers.end);
    if (timers.noSpeech) clearTimeout(timers.noSpeech);
    timers = {};
  }

  function arm(withSpeech: boolean) {
    clearTimers();
    if (!withSpeech) {
      timers.noSpeech = setTimeout(
        () => cancel("No speech was detected."),
        options.noSpeechMs ?? VOICE_TIMING.noSpeechMs,
      );
      return;
    }
    timers.pause = setTimeout(() => handlers.onPaused(true), VOICE_TIMING.pauseAfterMs);
    timers.end = setTimeout(finish, VOICE_TIMING.endAfterMs);
  }

  function finish() {
    if (settled) return;
    settled = true;
    clearTimers();
    const active = session;
    session = null;
    handlers.onRecording(false);
    handlers.onPaused(false);
    if (!active) return;
    void active.stop().then(
      (text) => handlers.onTranscript(text),
      (err) => handlers.onError(errorMessage(err)),
    );
  }

  function cancel(message?: string) {
    if (settled) return;
    settled = true;
    clearTimers();
    const active = session;
    session = null;
    active?.cancel();
    handlers.onRecording(false);
    handlers.onPaused(false);
    handlers.onPartial("");
    if (message) handlers.onError(message);
  }

  try {
    session = startBrowserStt({
      onPartial: (text) => {
        handlers.onPartial(text);
        if (!text.trim()) return;
        handlers.onPaused(false);
        arm(true);
      },
      onEnd: ({ text, error }) => {
        if (settled) return;
        settled = true;
        clearTimers();
        session = null;
        handlers.onRecording(false);
        handlers.onPaused(false);
        handlers.onPartial("");
        if (error) handlers.onError(error);
        else handlers.onTranscript(text);
      },
    });
    handlers.onRecording(true);
    arm(false);
  } catch (err) {
    settled = true;
    handlers.onError(errorMessage(err));
  }

  return { finish, cancel };
}
