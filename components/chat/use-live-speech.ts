"use client";
// Reads a voice turn's reply aloud while it is still streaming.
//
// The bubble reader waits for the persisted message, which means the user
// hears nothing until the whole reply exists. This hook starts on the first
// complete sentence of the live text and keeps feeding the queue, so the
// answer is already being spoken while the rest is still arriving.
//
// The session lives outside React on purpose: the live block disappears as
// soon as the persisted message lands, and cancelling on unmount would cut the
// last sentences off. It is only cancelled when the user stops it, the
// conversation ends, or a new reply takes over.
import { useEffect, useRef } from "react";
import type { AgentConfig } from "@/api/types";
import { pushErrorToast } from "@/lib/ui/error-report";
import { resolveReplyTtsEngine, type ReplyTtsEngine } from "@/lib/voice/tts/engine";
import { createStreamingSpeechSplitter, type StreamingSpeechSplitter } from "@/lib/voice/tts/stream";
import { consumeLiveSpeech, markLiveSpeechSpoken } from "./auto-speak";
import { createLiveSpeechQueue, type LiveSpeechQueue } from "./live-speech";
import {
  endVoiceConversation,
  notifyVoiceSpeechEnded,
  notifyVoiceSpeechFailed,
  notifyVoiceSpeechStarted,
} from "./voice-conversation";

// The live reply has no message id yet (it is persisted at finalize), so the
// conversation coordinator tracks it under a fixed name.
const LIVE_SPEECH_ID = "live-reply";

interface LiveSession {
  queue: LiveSpeechQueue;
  splitter: StreamingSpeechSplitter;
  /** Text already handed to the queue, used to detect a restarted reply. */
  seen: string;
  /** No more text will be fed; the queue may still be playing. */
  done: boolean;
  /** Audio actually started, so unmounting the view may stop it. */
  started: boolean;
  /** The user pressed Stop: this turn must not start reading again. */
  stopped: boolean;
}

let current: LiveSession | null = null;

/** Test seam: drops any session left over from a previous case. */
export function _resetLiveSpeech(): void {
  current?.queue.cancel();
  current = null;
}

function startSession(engine: ReplyTtsEngine, agentId: string | null, browserVoice: string | null): LiveSession | null {
  let queue: LiveSpeechQueue | null = null;
  // A holder, not a local: the start handler runs after this returns, and
  // TypeScript would otherwise narrow a never-reassigned local to null.
  const holder: { session: LiveSession | null } = { session: null };
  queue = createLiveSpeechQueue({
    engine,
    agentId,
    browserVoice,
    handlers: {
      // Claim the turn for the live reader as soon as audio is handed to the
      // engine. `onStart` waits for the browser's own `start` event, ~100 ms
      // later — and a short reply finalizes inside that window, which is when
      // the whole-message reader also fired, cancelled the live clip and read
      // the reply again from the top.
      onDispatch: () => markLiveSpeechSpoken(),
      onStart: () => {
        if (holder.session) holder.session.started = true;
        markLiveSpeechSpoken();
        notifyVoiceSpeechStarted(LIVE_SPEECH_ID, () => {
          // Stop: silence the clip, empty the queue, and make sure the rest of
          // this turn's text cannot start a new reader later.
          if (holder.session) holder.session.stopped = true;
          queue?.cancel();
        });
      },
      onDrain: () => notifyVoiceSpeechEnded(LIVE_SPEECH_ID),
      onError: (message) => {
        notifyVoiceSpeechFailed(LIVE_SPEECH_ID);
        endVoiceConversation();
        pushErrorToast({
          title: "Could not read the reply aloud",
          error: message,
          context: { panel: "chat", action: "live_speech", agent_id: agentId },
        });
      },
    },
  });
  if (!queue) {
    // Nothing can synthesize here: end the loop and say so, instead of leaving
    // the composer waiting for audio that will never arrive.
    endVoiceConversation();
    pushErrorToast({
      title: "Could not read the reply aloud",
      error: "no speech engine is available for this agent",
      context: { panel: "chat", action: "live_speech", agent_id: agentId },
    });
    return null;
  }
  holder.session = { queue, splitter: createStreamingSpeechSplitter(), seen: "", done: false, started: false, stopped: false };
  return holder.session;
}

export function useLiveSpeech({ content, streaming, agentConfig }: {
  content: string | undefined;
  streaming: boolean;
  agentConfig: AgentConfig | null | undefined;
}): void {
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const voiceEnabled = !!agentConfig?.voice_enabled;
  const ttsEngine = resolveReplyTtsEngine(agentConfig?.voice_stt_engine);
  const agentId = agentConfig?.id ?? null;
  const browserVoice = agentConfig?.voice_browser_voice ?? null;

  useEffect(() => {
    const text = content ?? "";
    // A live request belongs to one turn: consume it here, so a reply that
    // never streams still falls back to the finalize reader.
    if (voiceEnabled && consumeLiveSpeech()) {
      current?.queue.cancel();
      current = startSession(ttsEngine, agentId, browserVoice);
    }
    const session = current;
    if (!session || session.done) return;
    let active = session;

    // The live block can be cleared in the same commit that finalizes the run;
    // read the tail before letting the session go quiet.
    if (!text) {
      if (!session.seen) return;
      for (const chunk of session.splitter.take(session.seen, { flush: true })) session.queue.push(chunk);
    } else if (text.startsWith(session.seen)) {
      for (const chunk of session.splitter.take(text, { flush: !streaming })) session.queue.push(chunk);
      session.seen = text;
    } else {
      // A steer or a retry replaces the live text; what was read is stale, so
      // start a fresh reader rather than reading a suffix in isolation. After
      // Stop there is no reader to restart: the user asked for silence.
      if (session.stopped) {
        current = null;
        return;
      }
      session.queue.cancel();
      const restarted = startSession(ttsEngine, agentId, browserVoice);
      current = restarted;
      if (!restarted) return;
      for (const chunk of restarted.splitter.take(text, { flush: !streaming })) restarted.queue.push(chunk);
      restarted.seen = text;
      active = restarted;
    }
    if (!streaming) {
      active.done = true;
      active.queue.finish();
    }
  }, [content, streaming, voiceEnabled, ttsEngine, agentId, browserVoice]);

  // Leaving the thread mid-run must not keep talking; finishing the run must.
  // Only a clip that is actually speaking is stopped: React runs this cleanup
  // once per development mount (StrictMode, on by default for the App Router),
  // and cancelling there would throw away a reader that had not spoken yet —
  // the turn's live intent is already spent, so the reply went silent.
  useEffect(() => () => {
    if (current?.started && streamingRef.current) _resetLiveSpeech();
  }, []);
}
