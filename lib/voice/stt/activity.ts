// Mic-level voice activity monitor for the server STT engines (Whisper and
// Gemini). Web Speech owns its own audio, so the browser engine drives the
// same silence detector from transcript inactivity instead (see InputBar).
import {
  computeRms,
  createSilenceDetector,
  VOICE_TIMING,
  type SilenceEvent,
} from "./silence";

const SAMPLE_INTERVAL_MS = 100;

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

export interface VoiceActivityHandlers {
  onPause(): void;
  onResume(): void;
  onEnd(): void;
  onNoSpeech(): void;
}

export interface VoiceActivityMonitor {
  stop(): void;
}

/**
 * Watch a live mic stream and report the same pause/resume/end events as the
 * browser engine. Returns null when the browser has no Web Audio support — the
 * composer then exposes a manual Finish control instead of ending on silence.
 */
export function monitorVoiceActivity(
  stream: MediaStream,
  handlers: VoiceActivityHandlers,
): VoiceActivityMonitor | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;

  let context: AudioContext;
  try {
    context = new Ctor();
  } catch {
    return null;
  }

  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
  } catch {
    void context.close?.().catch(() => {});
    return null;
  }

  void context.resume?.().catch(() => {});

  const detector = createSilenceDetector(Date.now(), {
    pauseAfterMs: VOICE_TIMING.pauseAfterMs,
    endAfterMs: VOICE_TIMING.endAfterMs,
    noSpeechMs: VOICE_TIMING.noSpeechMs,
    maxCaptureMs: VOICE_TIMING.maxCaptureMs,
    speechThreshold: VOICE_TIMING.speechThreshold,
    speechStartMs: VOICE_TIMING.speechStartMs,
  });
  const buffer = new Uint8Array(analyser.fftSize);
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    try { source.disconnect(); } catch { /* already disconnected */ }
    try { analyser.disconnect(); } catch { /* already disconnected */ }
    void context.close?.().catch(() => {});
  }

  function dispatch(events: SilenceEvent[]) {
    for (const event of events) {
      if (event === "pause") handlers.onPause();
      else if (event === "resume") handlers.onResume();
      else if (event === "end") {
        stop();
        handlers.onEnd();
        return;
      } else if (event === "no-speech") {
        stop();
        handlers.onNoSpeech();
        return;
      }
      // `speech-start` has no UI state of its own; "Listening…" is already shown.
    }
  }

  timer = setInterval(() => {
    if (stopped) return;
    analyser.getByteTimeDomainData(buffer);
    dispatch(detector.sample(computeRms(buffer), Date.now()));
  }, SAMPLE_INTERVAL_MS);

  return { stop };
}
