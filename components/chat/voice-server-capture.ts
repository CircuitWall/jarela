// Server-engine hands-free capture (Whisper / Gemini).
//
// Records with MediaRecorder while a mic-level VAD drives the same pause/end
// states as the browser engine. Silence pauses the encoder briefly and a
// longer silence stops it, uploads the clip, and delivers the transcript.
import { transcribeOnServer } from "@/lib/voice/stt/server";
import { monitorVoiceActivity, type VoiceActivityMonitor } from "@/lib/voice/stt/activity";
import type { SttEngine } from "@/lib/voice/stt/types";
import { errorMessage } from "@/lib/utils/error";
import type { CaptureControls } from "./voice-capture-types";

export interface ServerCaptureHandlers {
  agentId: string;
  engine: SttEngine;
  onRecording(recording: boolean): void;
  onPaused(paused: boolean): void;
  onAutoEnd(available: boolean): void;
  onTranscribing(transcribing: boolean): void;
  onTranscript(text: string): void;
  onError(message: string): void;
}

export interface ServerCaptureOptions {
  /** Leading silence before the capture aborts. Conversation mode uses 5 s. */
  noSpeechMs?: number;
}

const NOOP: CaptureControls = { finish() { /* nothing to stop */ }, cancel() { /* nothing to stop */ } };

export async function startServerCapture(
  handlers: ServerCaptureHandlers,
  options: ServerCaptureOptions = {},
): Promise<CaptureControls> {
  let recorder: MediaRecorder | null = null;
  let monitor: VoiceActivityMonitor | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let discard = false;
  let finished = false;

  function cleanup() {
    monitor?.stop();
    monitor = null;
    const activeStream = stream;
    stream = null;
    activeStream?.getTracks().forEach((track) => track.stop());
    recorder = null;
  }

  function finish() {
    if (finished) return;
    finished = true;
    handlers.onRecording(false);
    handlers.onPaused(false);
    monitor?.stop();
    monitor = null;
    const active = recorder;
    try {
      if (active?.state === "paused") active.resume();
      if (active && active.state !== "inactive") active.stop();
      else cleanup();
    } catch {
      cleanup();
    }
  }

  function cancel(message?: string) {
    if (finished) return;
    finished = true;
    discard = true;
    handlers.onRecording(false);
    handlers.onPaused(false);
    const active = recorder;
    try {
      if (active && active.state !== "inactive") active.stop();
    } catch { /* onstop may still fire */ }
    cleanup();
    if (message) handlers.onError(message);
  }

  try {
    const activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream = activeStream;
    const mime =
      MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
          : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4"
            : "";
    const rec = mime ? new MediaRecorder(activeStream, { mimeType: mime }) : new MediaRecorder(activeStream);
    recorder = rec;
    chunks = [];
    rec.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
    rec.onerror = () => cancel("Recording failed. Try again.");
    rec.onstop = async () => {
      cleanup();
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      chunks = [];
      if (discard) return;
      if (blob.size === 0) {
        handlers.onError("No speech was detected.");
        return;
      }
      handlers.onTranscribing(true);
      try {
        handlers.onTranscript(await transcribeOnServer({ agentId: handlers.agentId, engine: handlers.engine, blob }));
      } catch (err) {
        handlers.onError(errorMessage(err));
      } finally {
        handlers.onTranscribing(false);
      }
    };
    rec.start();
    monitor = monitorVoiceActivity(activeStream, {
      onPause: () => {
        handlers.onPaused(true);
        try { if (rec.state === "recording") rec.pause(); } catch { /* ignore */ }
      },
      onResume: () => {
        handlers.onPaused(false);
        try { if (rec.state === "paused") rec.resume(); } catch { /* ignore */ }
      },
      onEnd: finish,
      onNoSpeech: () => cancel("No speech was detected."),
    }, options);
    handlers.onAutoEnd(monitor !== null);
    handlers.onRecording(true);
  } catch (err) {
    cleanup();
    handlers.onRecording(false);
    handlers.onPaused(false);
    handlers.onError(errorMessage(err));
    return NOOP;
  }

  return { finish, cancel };
}
