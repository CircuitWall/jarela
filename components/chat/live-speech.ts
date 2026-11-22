// Speech for a reply that is still streaming in.
//
// The whole-reply reader waits for the final message; this queue starts on the
// first complete sentence and keeps reading slices as they land. Slices are
// spoken one at a time so a long reply never queues a minute of audio ahead,
// and switching to the next slice only happens when the current one ends.
import { parseVoiceDirectives } from "@/lib/voice/tone";
import { isBrowserTtsAvailable, speakWithBrowser } from "@/lib/voice/tts/browser";
import type { ReplyTtsEngine } from "@/lib/voice/tts/engine";
import { cleanSpeechChunk } from "@/lib/voice/tts/text";
import { errorMessage } from "@/lib/utils/error";

const RETRY_DELAY_MS = 150;

export interface LiveSpeechHandlers {
  /** The first slice actually produced audio. */
  onStart(): void;
  /** Every queued slice finished and no more are coming. */
  onDrain(): void;
  onError(message: string): void;
}

export interface LiveSpeechQueue {
  push(text: string): void;
  finish(): void;
  cancel(): void;
}

interface Clip {
  text: string;
  style: string | null;
  audio: Promise<string> | null;
}

interface LiveSpeechOptions {
  engine: ReplyTtsEngine;
  agentId: string | null;
  handlers: LiveSpeechHandlers;
}

function synthesize(agentId: string, text: string, style: string | null): Promise<string> {
  return fetch("/api/v1/voice/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId, text, ...(style ? { style } : {}) }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as { error?: string }));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return URL.createObjectURL(await res.blob());
  });
}

/**
 * Returns null when this configuration cannot synthesize at all (no browser
 * voices and no Gemini agent), so the caller can stay silent instead of
 * queueing clips that will never play.
 */
export function createLiveSpeechQueue({ engine, agentId, handlers }: LiveSpeechOptions): LiveSpeechQueue | null {
  const useBrowser = engine === "browser" && isBrowserTtsAvailable();
  if (!useBrowser && !agentId) return null;
  const speechAgentId = agentId ?? "";

  const queue: Clip[] = [];
  let busy = false;
  let finished = false;
  let drained = false;
  let started = false;
  let cancelled = false;
  let stopActive: (() => void) | null = null;
  // Only the first slice may replace a clip that is already speaking; later
  // slices must be handed to an idle synth (see BrowserSpeechOptions.replace).
  let firstClip = true;

  function markStarted(): void {
    if (started || cancelled) return;
    started = true;
    handlers.onStart();
  }

  function attemptBrowser(clip: Clip, replace: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const session = speakWithBrowser(clip.text, {
        onStart: markStarted,
        onEnd: () => resolve(),
        onError: (message) => reject(new Error(message)),
      }, { replace });
      if (!session) {
        reject(new Error("this browser cannot synthesize speech"));
        return;
      }
      stopActive = () => {
        session.cancel();
        resolve();
      };
    });
  }

  async function playBrowser(clip: Clip): Promise<void> {
    const replace = firstClip;
    firstClip = false;
    try {
      await attemptBrowser(clip, replace);
      return;
    } catch {
      if (cancelled) return;
      // Chromium sometimes drops the clip that follows a cancel(); a single
      // retry on an idle synth recovers the slice instead of reporting an
      // error for audio the user can already hear.
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      if (cancelled) return;
      await attemptBrowser(clip, false);
    }
  }

  async function playGemini(clip: Clip): Promise<void> {
    if (!clip.audio) throw new Error("no audio for this slice");
    const url = await clip.audio;
    if (cancelled) {
      URL.revokeObjectURL(url);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const audio = new Audio(url);
      const release = () => {
        URL.revokeObjectURL(url);
        stopActive = null;
      };
      audio.onended = () => {
        release();
        resolve();
      };
      audio.onerror = () => {
        release();
        reject(new Error("playback failed"));
      };
      stopActive = () => {
        try { audio.pause(); } catch { /* already gone */ }
        release();
        resolve();
      };
      void audio.play().then(markStarted, (err) => {
        release();
        reject(err);
      });
    });
  }

  function pump(): void {
    if (busy || cancelled) return;
    if (queue.length === 0) {
      if (finished && !drained) {
        drained = true;
        handlers.onDrain();
      }
      return;
    }
    const clip = queue.shift()!;
    busy = true;
    const played = useBrowser ? playBrowser(clip) : playGemini(clip);
    void played.then(
      () => {
        busy = false;
        stopActive = null;
        pump();
      },
      (err) => {
        busy = false;
        stopActive = null;
        if (cancelled) return;
        handlers.onError(errorMessage(err));
      },
    );
  }

  return {
    push(text) {
      if (cancelled) return;
      const { text: directed, style } = parseVoiceDirectives(text);
      // Text may arrive straight from a stream without the splitter's cleanup.
      const speakable = cleanSpeechChunk(directed);
      if (!speakable) return;
      // Gemini clips are requested as soon as the text exists, so the next
      // slice is usually buffered by the time the current one ends.
      queue.push({
        text: speakable,
        style,
        audio: useBrowser ? null : synthesize(speechAgentId, speakable, style),
      });
      pump();
    },
    finish() {
      if (cancelled) return;
      finished = true;
      pump();
    },
    cancel() {
      cancelled = true;
      queue.length = 0;
      stopActive?.();
      stopActive = null;
    },
  };
}
