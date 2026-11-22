// Continuous voice-conversation coordinator.
//
// TTS state lives in a message bubble; capture state lives in the composer.
// This module is the small shared state machine between them:
//
//   auto-spoken voice reply starts -> speaking
//   speech ends or Stop is pressed -> request listening
//   composer consumes the request -> starts capture
//   5 s of silence in capture -> caller ends the conversation
//
// Only speech started by the auto-speak path registers here; a manual Play
// button must not silently turn on the microphone.
export type VoiceConversationEvent =
  | { type: "state"; active: boolean; speaking: boolean }
  | { type: "listen" }
  | { type: "end" };

type Listener = (event: VoiceConversationEvent) => boolean | void;

let active = false;
let speakingMessageId: string | null = null;
let stopSpeech: (() => void) | null = null;
let pendingListen = false;
const listeners = new Set<Listener>();

function emit(event: VoiceConversationEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A broken listener must not stop the rest of the loop.
    }
  }
}

function stateEvent(): VoiceConversationEvent {
  return { type: "state", active, speaking: speakingMessageId !== null };
}

export function getVoiceConversationState(): { active: boolean; speaking: boolean } {
  return { active, speaking: speakingMessageId !== null };
}

export function subscribeVoiceConversation(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Registers the clip that is currently being read aloud. */
export function notifyVoiceSpeechStarted(messageId: string, stop: () => void): void {
  active = true;
  speakingMessageId = messageId;
  stopSpeech = stop;
  emit(stateEvent());
}

/** Natural end of the clip: begin listening for the next turn. */
export function notifyVoiceSpeechEnded(messageId: string): void {
  if (speakingMessageId !== messageId) return;
  speakingMessageId = null;
  stopSpeech = null;
  emit(stateEvent());
  requestVoiceListen();
}

/** A failed clip ends the loop rather than leaving the mic waiting forever. */
export function notifyVoiceSpeechFailed(messageId: string): void {
  if (speakingMessageId !== messageId) return;
  endVoiceConversation();
}

/** Stop reading and immediately listen for the next turn. */
export function stopVoiceSpeech(): boolean {
  if (!stopSpeech) return false;
  const stop = stopSpeech;
  stopSpeech = null;
  speakingMessageId = null;
  emit(stateEvent());
  try {
    stop();
  } catch {
    // The clip is gone either way; listening should still start.
  }
  requestVoiceListen();
  return true;
}

export function requestVoiceListen(): void {
  if (!active) return;
  pendingListen = true;
  for (const listener of listeners) {
    let handled = false;
    try {
      handled = listener({ type: "listen" }) === true;
    } catch {
      // Ignore and try the next listener.
    }
    if (handled) {
      pendingListen = false;
      return;
    }
  }
}

/** True exactly once for a listen request that arrived before the composer subscribed. */
export function consumeVoiceListen(): boolean {
  if (!pendingListen) return false;
  pendingListen = false;
  return true;
}

export function endVoiceConversation(): void {
  const wasActive = active;
  const stop = stopSpeech;
  active = false;
  speakingMessageId = null;
  stopSpeech = null;
  pendingListen = false;
  if (wasActive) emit({ type: "end" });
  emit({ type: "state", active: false, speaking: false });
  // Ending the loop while a clip is still reading (manual mic press, failed
  // clip) must silence it: the mic would otherwise pick the audio back up.
  if (stop) {
    try {
      stop();
    } catch {
      // The clip is gone either way.
    }
  }
}

export function _resetVoiceConversation(): void {
  active = false;
  speakingMessageId = null;
  stopSpeech = null;
  pendingListen = false;
  listeners.clear();
}
