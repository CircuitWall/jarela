// Reliable handoff for "speak the new reply".
//
// A window event dispatched in a single animation frame can be lost when a
// tool-heavy turn remounts the message list: the bubble may not have mounted a
// listener yet, and there is no second chance. Requests are therefore parked by
// message id until a live listener handles them or the bubble mounts and
// consumes them. A consumed request never replays.
const TTL_MS = 30_000;

const pending = new Map<string, number>();
const listeners = new Set<(messageId: string) => boolean>();

export function requestAutoSpeak(messageId: string): void {
  if (!messageId) return;
  const now = Date.now();
  pending.delete(messageId);
  for (const [id, at] of pending) {
    if (now - at > TTL_MS) pending.delete(id);
  }
  for (const listener of listeners) {
    let handled = false;
    try {
      handled = listener(messageId);
    } catch {
      // One broken listener must not stop delivery to the others.
    }
    if (handled) return;
  }
  pending.set(messageId, now);
}

export function subscribeAutoSpeak(listener: (messageId: string) => boolean): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True exactly once for a parked request, so a re-render cannot replay it. */
export function consumeAutoSpeak(messageId: string): boolean {
  if (!pending.has(messageId)) return false;
  pending.delete(messageId);
  return true;
}

export function _resetAutoSpeak(): void {
  pending.clear();
  listeners.clear();
}
