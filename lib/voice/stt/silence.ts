// Hands-free end-of-turn detection for voice input.
//
// The composer records until the speaker pauses. A short silence pauses the
// capture (so the UI can say "keep talking" and drop the silent gap); a longer
// silence ends the turn and hands the transcript to the send path. The state
// machine is pure so the timing rules are unit-testable without a microphone.
//
// `browser` feeds it transcript inactivity (Web Speech owns the audio), while
// `whisper`/`gemini` feed RMS samples from an AnalyserNode on the mic stream.

export type SilencePhase = "waiting" | "speaking" | "paused" | "ended";

export type SilenceEvent = "speech-start" | "pause" | "resume" | "end" | "no-speech";

export interface SilenceDetectorOptions {
  /** Silence that pauses the capture and shows "keep talking". 0 disables pausing. */
  pauseAfterMs?: number;
  /** Silence that ends the turn and sends the transcript. */
  endAfterMs?: number;
  /** Time with no speech at all before the capture aborts with "no speech". */
  noSpeechMs?: number;
  /** Hard cap so a forgotten mic cannot record forever. */
  maxCaptureMs?: number;
  /** RMS above which a frame counts as speech (0–1, 16-bit PCM normalized). */
  speechThreshold?: number;
  /** Sustained loud audio required before the turn is considered started. */
  speechStartMs?: number;
}

export const VOICE_TIMING = Object.freeze({
  pauseAfterMs: 600,
  endAfterMs: 1_200,
  noSpeechMs: 10_000,
  maxCaptureMs: 120_000,
  speechThreshold: 0.02,
  speechStartMs: 200,
});

const DEFAULTS = VOICE_TIMING;

export interface SilenceDetector {
  readonly phase: SilencePhase;
  /** Feed one RMS sample observed at `now` (milliseconds). */
  sample(rms: number, now: number): SilenceEvent[];
}

/** Root-mean-square of 8-bit time-domain samples centred on 128. */
export function computeRms(bytes: Uint8Array | number[]): number {
  if (!bytes || bytes.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const centered = (bytes[i] - 128) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / bytes.length);
}

export function createSilenceDetector(
  startedAt: number,
  options: SilenceDetectorOptions = {},
): SilenceDetector {
  const pauseAfterMs = options.pauseAfterMs ?? DEFAULTS.pauseAfterMs;
  const endAfterMs = options.endAfterMs ?? DEFAULTS.endAfterMs;
  const noSpeechMs = options.noSpeechMs ?? DEFAULTS.noSpeechMs;
  const maxCaptureMs = options.maxCaptureMs ?? DEFAULTS.maxCaptureMs;
  const speechThreshold = options.speechThreshold ?? DEFAULTS.speechThreshold;
  const speechStartMs = options.speechStartMs ?? DEFAULTS.speechStartMs;

  let phase: SilencePhase = "waiting";
  let lastAt = startedAt;
  let lastVoiceAt = startedAt;
  let loudForMs = 0;

  function finish(reason: SilenceEvent): SilenceEvent[] {
    phase = "ended";
    return [reason];
  }

  return {
    get phase() {
      return phase;
    },
    sample(rms: number, now: number) {
      if (phase === "ended") return [];
      const at = Number.isFinite(now) ? now : lastAt;
      const dt = Math.max(0, at - lastAt);
      lastAt = at;
      const level = Number.isFinite(rms) ? rms : 0;

      if (at - startedAt >= maxCaptureMs) {
        return finish(phase === "waiting" ? "no-speech" : "end");
      }

      if (phase === "waiting") {
        if (level >= speechThreshold) {
          loudForMs += dt;
          if (loudForMs >= speechStartMs) {
            phase = "speaking";
            lastVoiceAt = at;
            return ["speech-start"];
          }
        } else {
          loudForMs = Math.max(0, loudForMs - dt);
        }
        if (at - startedAt >= noSpeechMs) return finish("no-speech");
        return [];
      }

      if (phase === "speaking") {
        if (level >= speechThreshold) {
          lastVoiceAt = at;
          return [];
        }
        const quietFor = at - lastVoiceAt;
        // Check the terminal silence first so a large sampling gap ends the
        // turn instead of pausing and waiting for another sample.
        if (quietFor >= endAfterMs) return finish("end");
        if (pauseAfterMs > 0 && pauseAfterMs < endAfterMs && quietFor >= pauseAfterMs) {
          phase = "paused";
          return ["pause"];
        }
        return [];
      }

      // paused
      if (level >= speechThreshold) {
        phase = "speaking";
        lastVoiceAt = at;
        return ["resume"];
      }
      if (at - lastVoiceAt >= endAfterMs) return finish("end");
      return [];
    },
  };
}
